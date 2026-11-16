use std::env;
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

fn tcp_reachable(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(180)).is_ok()
}

fn find_webview_host() -> Option<&'static str> {
    let candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    ];
    candidates.into_iter().find(|p| Path::new(p).exists())
}

fn print_doctor_json() {
    let ai_os_bin = Path::new(r"%USERPROFILE%\.local\bin\ai-os.exe").exists();
    let agy_studio_bin = Path::new(r"%USERPROFILE%\.local\bin\agy-studio.exe").exists();
    let ai_os_listening = tcp_reachable(4318);
    let agy_web_listening = tcp_reachable(4325);
    let webview = find_webview_host().unwrap_or("none");

    println!(
        "{{\"ok\":true,\"binary\":\"agy-desktop\",\"version\":\"2.0.0\",\"edition\":\"rust-2024-fat-lto\",\"aiOsBinary\":{},\"agyStudioBinary\":{},\"aiOsPort4318\":{},\"agyWebPort4325\":{},\"nativeAppHost\":\"{}\"}}",
        ai_os_bin,
        agy_studio_bin,
        ai_os_listening,
        agy_web_listening,
        webview.replace('\\', "/")
    );
}

fn render_tui_snapshot() {
    let ai_os_up = if tcp_reachable(4318) { "ONLINE" } else { "STANDBY" };
    let agy_web_up = if tcp_reachable(4325) { "ONLINE" } else { "STANDBY" };
    println!("==================================================================");
    println!(" AGY NATIVE RUST DESKTOP SHELL v2.0.0 (Rust 2024 Fat-LTO)");
    println!("==================================================================");
    println!(" Sole AI Owner (@aphrody/ai-os :4318) : {}", ai_os_up);
    println!(" AGY Studio & Gemini Web (:4325)      : {}", agy_web_up);
    println!(" Local Gemma 4 RTX 4070 sm_89         : gemma-4-12b-heretic-q4km");
    println!(" Modes Available                      : minimal (pi-sudo) | fullstack");
    println!("==================================================================");
}

fn ensure_agy_web_running() {
    if tcp_reachable(4325) {
        return;
    }
    let studio_bin = r"%USERPROFILE%\.local\bin\agy-studio.exe";
    if Path::new(studio_bin).exists() {
        let _ = Command::new(studio_bin)
            .args(["web", "--port", "4325"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        std::thread::sleep(Duration::from_millis(350));
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let sub = args.first().map(String::as_str).unwrap_or("tui");

    match sub {
        "doctor" | "--doctor" | "--version" | "-v" => {
            print_doctor_json();
        }
        "tui" | "--tui" | "status" => {
            render_tui_snapshot();
        }
        "launch" | "window" => {
            ensure_agy_web_running();
            if let Some(host) = find_webview_host() {
                let _ = Command::new(host)
                    .args([
                        "--app=http://127.0.0.1:4325",
                        "--window-size=1360,880",
                    ])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn();
                println!("{{\"ok\":true,\"launched\":true,\"url\":\"http://127.0.0.1:4325\"}}");
            } else {
                render_tui_snapshot();
            }
        }
        _ => {
            println!("Usage: agy-desktop <doctor|tui|launch>");
        }
    }
}
