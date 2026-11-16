use crate::config::{AppConfig, ConfigManager};
use crate::inference::{ChatCompletionRequest, EmbeddingRequest, TriBackendInferenceRouter};
use crate::webgpu_assets::WEBGPU_HTML;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

pub struct HttpServer {
    bind_addr: String,
    config_mgr: ConfigManager,
    inference: Arc<TriBackendInferenceRouter>,
    running: Arc<AtomicBool>,
}

impl HttpServer {
    pub fn new(config_mgr: ConfigManager) -> Self {
        let cfg = config_mgr.get_config();
        let inference = Arc::new(TriBackendInferenceRouter::new(cfg.inference.clone()));
        Self {
            bind_addr: cfg.server.bind.clone(),
            config_mgr,
            inference,
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::Release);
    }

    pub fn start(&self) -> Result<(), String> {
        let listener = TcpListener::bind(&self.bind_addr)
            .map_err(|e| format!("failed to bind TCP listener to {}: {}", self.bind_addr, e))?;

        // Non-blocking with timeout so the listener can exit when stopped
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("failed to set nonblocking: {}", e))?;

        self.running.store(true, Ordering::Release);

        while self.running.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let cfg_mgr = self.config_mgr.clone();
                    let inf = self.inference.clone();
                    thread::spawn(move || {
                        handle_connection(stream, cfg_mgr, inf);
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(_) => {
                    break;
                }
            }
        }

        Ok(())
    }
}

fn handle_connection(
    mut stream: TcpStream,
    config_mgr: ConfigManager,
    inference: Arc<TriBackendInferenceRouter>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));

    let mut buffer = [0u8; 8192];
    let bytes_read = match stream.read(&mut buffer) {
        Ok(n) if n > 0 => n,
        _ => return,
    };

    let req_str = String::from_utf8_lossy(&buffer[..bytes_read]);
    let mut lines = req_str.lines();
    let request_line = match lines.next() {
        Some(l) => l,
        None => return,
    };

    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        return;
    }

    let method = parts[0];
    let path = parts[1];

    // Handle OPTIONS for CORS
    if method == "OPTIONS" {
        let resp = "HTTP/1.1 204 No Content\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS\r\n\
Access-Control-Allow-Headers: Content-Type, Authorization\r\n\
Connection: close\r\n\r\n";
        let _ = stream.write_all(resp.as_bytes());
        return;
    }

    // Extract body if any
    let body = if let Some(pos) = req_str.find("\r\n\r\n") {
        &req_str[pos + 4..]
    } else {
        ""
    };

    // Route matching
    match (method, path) {
        // Short routes
        ("GET", "/ok") | ("GET", "/healthz") => {
            let json = serde_json::json!({
                "status": "ok",
                "daemon": "r3d",
                "ring": 3,
                "version": "0.1.0"
            });
            send_json_response(&mut stream, 200, "OK", &json.to_string());
        }

        ("GET", "/stat") | ("GET", "/v1/telemetry") => {
            let telem = inference.telemetry(config_mgr.is_enabled());
            let json = serde_json::to_string(&telem).unwrap_or_default();
            send_json_response(&mut stream, 200, "OK", &json);
        }

        ("GET", "/cfg") | ("GET", "/v1/config") => {
            let cfg = config_mgr.get_config();
            let json = serde_json::to_string(&cfg).unwrap_or_default();
            send_json_response(&mut stream, 200, "OK", &json);
        }

        ("PUT", "/cfg") | ("PUT", "/v1/config") => {
            match serde_json::from_str::<AppConfig>(body) {
                Ok(new_cfg) => {
                    config_mgr.update_config(new_cfg);
                    let json = serde_json::json!({"status": "updated", "enabled": config_mgr.is_enabled()});
                    send_json_response(&mut stream, 200, "OK", &json.to_string());
                }
                Err(e) => {
                    let err = serde_json::json!({"error": format!("invalid config payload: {}", e)});
                    send_json_response(&mut stream, 400, "Bad Request", &err.to_string());
                }
            }
        }

        ("POST", "/off") | ("POST", "/v1/disable") => {
            config_mgr.set_enabled(false);
            let json = serde_json::json!({
                "status": "disabled",
                "enabled": false,
                "latency_us": 1
            });
            send_json_response(&mut stream, 200, "OK", &json.to_string());
        }

        ("POST", "/on") | ("POST", "/v1/enable") => {
            config_mgr.set_enabled(true);
            let json = serde_json::json!({
                "status": "enabled",
                "enabled": true,
                "latency_us": 1
            });
            send_json_response(&mut stream, 200, "OK", &json.to_string());
        }

        ("GET", "/models") | ("GET", "/v1/models") => {
            let cfg = config_mgr.get_config();
            let json = serde_json::json!({
                "object": "list",
                "data": cfg.inference.models
            });
            send_json_response(&mut stream, 200, "OK", &json.to_string());
        }

        ("POST", "/chat") | ("POST", "/v1/chat/completions") => {
            if !config_mgr.is_enabled() {
                let err = serde_json::json!({"error": "r3d is currently disabled via instant kill-switch"});
                send_json_response(&mut stream, 503, "Service Unavailable", &err.to_string());
                return;
            }

            match serde_json::from_str::<ChatCompletionRequest>(body) {
                Ok(req) => {
                    if req.stream.unwrap_or(false) {
                        send_sse_chat_response(&mut stream, &req, &inference);
                    } else {
                        let resp = inference.complete(&req);
                        let json = serde_json::to_string(&resp).unwrap_or_default();
                        send_json_response(&mut stream, 200, "OK", &json);
                    }
                }
                Err(e) => {
                    let err = serde_json::json!({"error": format!("invalid chat request payload: {}", e)});
                    send_json_response(&mut stream, 400, "Bad Request", &err.to_string());
                }
            }
        }

        ("POST", "/embed") | ("POST", "/v1/embeddings") => {
            if !config_mgr.is_enabled() {
                let err = serde_json::json!({"error": "r3d is currently disabled via instant kill-switch"});
                send_json_response(&mut stream, 503, "Service Unavailable", &err.to_string());
                return;
            }

            match serde_json::from_str::<EmbeddingRequest>(body) {
                Ok(req) => {
                    let resp = inference.embed(&req.input);
                    let json = serde_json::to_string(&resp).unwrap_or_default();
                    send_json_response(&mut stream, 200, "OK", &json);
                }
                Err(e) => {
                    let err = serde_json::json!({"error": format!("invalid embedding request payload: {}", e)});
                    send_json_response(&mut stream, 400, "Bad Request", &err.to_string());
                }
            }
        }

        ("GET", "/gpu") | ("GET", "/webgpu") => {
            send_html_response(&mut stream, 200, "OK", WEBGPU_HTML);
        }

        _ => {
            let json = serde_json::json!({"error": "not found"});
            send_json_response(&mut stream, 404, "Not Found", &json.to_string());
        }
    }
}

fn send_json_response(stream: &mut TcpStream, code: u16, status: &str, body: &str) {
    let header = format!(
        "HTTP/1.1 {} {}\r\n\
Content-Type: application/json; charset=utf-8\r\n\
Access-Control-Allow-Origin: *\r\n\
Content-Length: {}\r\n\
Connection: close\r\n\r\n",
        code,
        status,
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn send_html_response(stream: &mut TcpStream, code: u16, status: &str, body: &str) {
    let header = format!(
        "HTTP/1.1 {} {}\r\n\
Content-Type: text/html; charset=utf-8\r\n\
Access-Control-Allow-Origin: *\r\n\
Content-Length: {}\r\n\
Connection: close\r\n\r\n",
        code,
        status,
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn send_sse_chat_response(
    stream: &mut TcpStream,
    req: &ChatCompletionRequest,
    inference: &TriBackendInferenceRouter,
) {
    let header = "HTTP/1.1 200 OK\r\n\
Content-Type: text/event-stream\r\n\
Cache-Control: no-cache\r\n\
Access-Control-Allow-Origin: *\r\n\
Connection: keep-alive\r\n\r\n";

    if stream.write_all(header.as_bytes()).is_err() {
        return;
    }

    let resp = inference.complete(req);
    let full_content = &resp.choices[0].message.content;

    // Stream tokens chunk by chunk
    for word in full_content.split_whitespace() {
        let chunk_json = serde_json::json!({
            "id": resp.id,
            "object": "chat.completion.chunk",
            "created": resp.created,
            "model": resp.model,
            "choices": [{
                "index": 0,
                "delta": { "content": format!("{} ", word) },
                "finish_reason": null
            }]
        });

        let msg = format!("data: {}\n\n", chunk_json);
        if stream.write_all(msg.as_bytes()).is_err() {
            return;
        }
        let _ = stream.flush();
        thread::sleep(Duration::from_millis(20));
    }

    let end_json = serde_json::json!({
        "id": resp.id,
        "object": "chat.completion.chunk",
        "created": resp.created,
        "model": resp.model,
        "choices": [{
            "index": 0,
            "delta": {},
            "finish_reason": "stop"
        }]
    });
    let _ = stream.write_all(format!("data: {}\n\ndata: [DONE]\n\n", end_json).as_bytes());
    let _ = stream.flush();
}
