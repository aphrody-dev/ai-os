use ring3_agent::config::{AppConfig, ConfigManager};
use ring3_agent::gpu_diet::{query_nvidia_vram, WindowsGpuDiet};
use ring3_agent::http_server::HttpServer;
use ring3_agent::inference::{
    ChatCompletionRequest, ChatMessage, TriBackendInferenceRouter,
};
use ring3_agent::inference_cpu_avx2::{
    dot_product_q8_0_f32, rmsnorm, softmax, BlockQ8_0, MicroTransformer,
};
use ring3_agent::systemd::SystemdUnitGenerator;
use ring3_agent::webgpu_assets::{WEBGPU_HTML, WGSL_COMPUTE_KERNEL};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::thread;
use std::time::Duration;

#[test]
fn test_config_instant_switch() {
    let mut cfg = AppConfig::default();
    cfg.server.enabled = true;
    let mgr = ConfigManager::new(cfg);

    assert!(mgr.is_enabled());

    let t0 = std::time::Instant::now();
    mgr.set_enabled(false);
    let elapsed_us = t0.elapsed().as_micros();

    assert!(!mgr.is_enabled());
    assert!(
        elapsed_us < 1000,
        "Instant disable toggle took {} us, must be < 1ms",
        elapsed_us
    );

    mgr.set_enabled(true);
    assert!(mgr.is_enabled());
}

#[test]
fn test_systemd_high_pid_unit_generation() {
    let unit = SystemdUnitGenerator::generate_unit("/usr/local/bin/r3d", "/etc/r3d/ring3-agent.toml");
    assert!(unit.contains("DefaultDependencies=no"));
    assert!(unit.contains("After=local-fs.target"));
    assert!(unit.contains("CPUSchedulingPolicy=fifo"));
    assert!(unit.contains("Nice=-15"));
    assert!(unit.contains("OOMScoreAdjust=-900"));
    assert!(unit.contains("Slice=ring3-ai.slice"));
    assert!(unit.contains("MemoryHigh=4G"));
    assert!(unit.contains("ExecStart=/usr/local/bin/r3d --config /etc/r3d/ring3-agent.toml"));
}

#[test]
fn test_gpu_diet_safety_and_vram_query() {
    let (total, used, free) = query_nvidia_vram();
    assert!(total >= 1024, "Expected total VRAM >= 1024 MB");
    assert!(free <= total);
    assert!(used <= total);

    // Non-destructive restore fallback test
    let res = WindowsGpuDiet::restore("non_existent_gpu_diet_backup.json");
    assert!(res.is_ok());
}

#[test]
fn test_avx2_quantized_q8_and_transformer() {
    // 1. Quantization accuracy
    let mut raw = [0.0f32; 32];
    for i in 0..32 {
        raw[i] = ((i as f32) - 16.0) / 10.0;
    }
    let block = BlockQ8_0::quantize(&raw);
    assert!(block.scale > 0.0);

    // 2. Dot-product
    let blocks = vec![block];
    let vec_f32 = raw.to_vec();
    let dot = dot_product_q8_0_f32(&blocks, &vec_f32);
    assert!(dot > 0.0);

    // 3. RMSNorm
    let weights = vec![1.0f32; 32];
    let norm = rmsnorm(&raw, &weights, 1e-5);
    assert_eq!(norm.len(), 32);
    let sum_sq: f32 = norm.iter().map(|v| v * v).sum();
    let mean_sq = sum_sq / 32.0;
    assert!((mean_sq - 1.0).abs() < 0.1);

    // 4. Softmax
    let mut logits = vec![1.0f32, 2.0f32, 3.0f32, 4.0f32];
    softmax(&mut logits, 1.0);
    let sum: f32 = logits.iter().sum();
    assert!((sum - 1.0).abs() < 1e-5);

    // 5. MicroTransformer text generation
    let transformer = MicroTransformer::new();
    let out = transformer.generate_completion("Test prompt", 8, 0.7);
    assert!(out.contains("[Ring-3 AVX2 Engine]:"));
}

#[test]
fn test_inference_router_and_embeddings() {
    let cfg = AppConfig::default();
    let router = TriBackendInferenceRouter::new(cfg.inference);

    // Test completion
    let req = ChatCompletionRequest {
        model: Some("r3d-q8-nano".to_string()),
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: "Ping agent".to_string(),
        }],
        temperature: Some(0.7),
        max_tokens: Some(8),
        stream: Some(false),
    };
    let resp = router.complete(&req);
    assert_eq!(resp.model, "r3d-q8-nano");
    assert!(!resp.choices.is_empty());

    // Test embeddings normalization (L2 norm == 1.0)
    let emb_req = vec!["Ring-3 sovereign inference".to_string()];
    let emb_resp = router.embed(&emb_req);
    assert_eq!(emb_resp.data.len(), 1);
    let vec = &emb_resp.data[0].embedding;
    assert_eq!(vec.len(), 384);
    let norm_sq: f32 = vec.iter().map(|v| v * v).sum();
    assert!((norm_sq.sqrt() - 1.0).abs() < 1e-4);
}

#[test]
fn test_webgpu_wgsl_asset_spec() {
    assert!(WEBGPU_HTML.contains("<!DOCTYPE html>"));
    assert!(WEBGPU_HTML.contains("<html lang=\"en\">"));
    assert!(WEBGPU_HTML.contains("<meta name=\"viewport\""));
    assert!(WEBGPU_HTML.contains("r3d // WebGPU In-Browser WGSL Inference Substrate"));
    assert!(WGSL_COMPUTE_KERNEL.contains("@compute @workgroup_size(64)"));
    assert!(WGSL_COMPUTE_KERNEL.contains("fn matvec_main"));
}

#[test]
fn test_http_server_endpoints_and_killswitch() {
    let mut cfg = AppConfig::default();
    cfg.server.bind = "127.0.0.1:18088".to_string();
    cfg.server.enabled = true;

    let mgr = ConfigManager::new(cfg);
    let server = HttpServer::new(mgr.clone());

    let _server_thread = thread::spawn(move || {
        let _ = server.start();
    });

    // Give server 50ms to bind
    thread::sleep(Duration::from_millis(100));

    // Helper to send HTTP request
    let send_req = |req: &str| -> String {
        let mut stream = TcpStream::connect("127.0.0.1:18088").expect("failed to connect");
        stream.write_all(req.as_bytes()).unwrap();
        let mut resp = Vec::new();
        let mut buf = [0u8; 1024];
        while let Ok(n) = stream.read(&mut buf) {
            if n == 0 {
                break;
            }
            resp.extend_from_slice(&buf[..n]);
        }
        String::from_utf8_lossy(&resp).to_string()
    };

    // 1. GET /ok
    let res = send_req("GET /ok HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    assert!(res.contains("200 OK"));
    assert!(res.contains("\"status\":\"ok\""));

    // 2. GET /stat
    let res = send_req("GET /stat HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    assert!(res.contains("200 OK"));
    assert!(res.contains("\"daemon\":\"r3d\""));

    // 3. GET /models
    let res = send_req("GET /models HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    assert!(res.contains("200 OK"));
    assert!(res.contains("r3d-q8-nano"));

    // 4. POST /chat
    let chat_body = serde_json::json!({
        "messages": [{"role": "user", "content": "hello"}],
        "stream": false
    })
    .to_string();
    let req_chat = format!(
        "POST /chat HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\n\r\n{}",
        chat_body.len(),
        chat_body
    );
    let res = send_req(&req_chat);
    assert!(res.contains("200 OK"));
    assert!(res.contains("chat.completion"));

    // 5. POST /off (Instant killswitch)
    let res = send_req("POST /off HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    assert!(res.contains("200 OK"));
    assert!(res.contains("\"disabled\""));

    // 6. POST /chat when disabled -> 503
    let res = send_req(&req_chat);
    assert!(res.contains("503 Service Unavailable"));

    // 7. POST /on (Re-enable)
    let res = send_req("POST /on HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    assert!(res.contains("200 OK"));
    assert!(res.contains("\"enabled\""));

    // 8. POST /chat now works again
    let res = send_req(&req_chat);
    assert!(res.contains("200 OK"));

    // 9. GET /gpu
    let res = send_req("GET /gpu HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    assert!(res.contains("200 OK"));
    assert!(res.contains("r3d // WebGPU In-Browser WGSL Inference Substrate"));
}
