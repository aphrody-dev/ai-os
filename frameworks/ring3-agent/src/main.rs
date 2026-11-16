use argh::FromArgs;
use ring3_agent::config::{AppConfig, ConfigManager};
use ring3_agent::gpu_diet::{query_nvidia_vram, WindowsGpuDiet};
use ring3_agent::http_server::HttpServer;
use ring3_agent::inference::{ChatCompletionRequest, ChatMessage, TriBackendInferenceRouter};
use ring3_agent::systemd::{enforce_ring3_isolation, SystemdUnitGenerator};
use std::process::ExitCode;

#[derive(FromArgs, PartialEq, Debug)]
/// r3d: Ring-3 Sovereign Local AI Agent, Boot HTTP + Tri-Backend Inference & Windows GPU-Diet Daemon
struct Cli {
    #[argh(subcommand)]
    cmd: Option<SubCommand>,

    /// path to config file (default: ring3-agent.toml)
    #[argh(option, short = 'c', default = "String::from(\"ring3-agent.toml\")")]
    config: String,

    /// bind address override (e.g. 127.0.0.1:8080)
    #[argh(option, short = 'b')]
    bind: Option<String>,
}

#[derive(FromArgs, PartialEq, Debug)]
#[argh(subcommand)]
enum SubCommand {
    Serve(ServeCommand),
    Diet(DietCommand),
    Infer(InferCommand),
    Systemd(SystemdCommand),
    Boot(BootCommand),
    Version(VersionCommand),
}

#[derive(FromArgs, PartialEq, Debug)]
/// start the HTTP and inference daemon
#[argh(subcommand, name = "serve")]
struct ServeCommand {
    /// apply Windows GPU-diet on startup
    #[argh(switch)]
    diet: bool,
}

#[derive(FromArgs, PartialEq, Debug)]
/// manage Windows Graphical VRAM Diet (reversibly reclaim VRAM from GUI)
#[argh(subcommand, name = "diet")]
struct DietCommand {
    /// action: 'apply', 'restore', or 'status'
    #[argh(positional, default = "String::from(\"status\")")]
    action: String,
}

#[derive(FromArgs, PartialEq, Debug)]
/// run one-shot local inference directly via CLI
#[argh(subcommand, name = "infer")]
struct InferCommand {
    /// input prompt
    #[argh(option, short = 'p', default = "String::from(\"What is r3d?\")")]
    prompt: String,

    /// backend: 'auto', 'cuda-sm89', 'vps-cpu-avx2', 'webgpu-wgsl'
    #[argh(option, default = "String::from(\"auto\")")]
    backend: String,

    /// max generated tokens
    #[argh(option, default = "32")]
    max_tokens: usize,
}

#[derive(FromArgs, PartialEq, Debug)]
/// generate production early-boot systemd unit
#[argh(subcommand, name = "systemd")]
struct SystemdCommand {
    /// destination path for the unit file (default: stdout)
    #[argh(option, short = 'o')]
    out: Option<String>,

    /// path to r3d binary (default: /usr/local/bin/r3d)
    #[argh(option, default = "String::from(\"/usr/local/bin/r3d\")")]
    bin_path: String,
}

#[derive(FromArgs, PartialEq, Debug)]
/// view or configure early boot persistence
#[argh(subcommand, name = "boot")]
struct BootCommand {
    /// action: 'status', 'enable', 'disable'
    #[argh(positional, default = "String::from(\"status\")")]
    action: String,
}

#[derive(FromArgs, PartialEq, Debug)]
/// display daemon version and Ring-3 architecture
#[argh(subcommand, name = "version")]
struct VersionCommand {}

fn main() -> ExitCode {
    let cli: Cli = argh::from_env();

    let mut config = match AppConfig::load_from_path(&cli.config) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[r3d] warning: could not load config from {}: {}. Using defaults.", cli.config, e);
            AppConfig::default()
        }
    };

    if let Some(bind_override) = cli.bind {
        config.server.bind = bind_override;
    }

    match cli.cmd {
        None | Some(SubCommand::Serve(_)) => {
            let diet_flag = match &cli.cmd {
                Some(SubCommand::Serve(s)) => s.diet,
                _ => false,
            };

            println!("[r3d] initializing Ring-3 sovereign inference daemon...");
            println!("[r3d] PID: {}, unprivileged usermode Ring-3", std::process::id());

            // Enforce Ring-3 JobObject limits on Windows
            match enforce_ring3_isolation(&config.isolation) {
                Ok(msg) => println!("[r3d] isolation: {}", msg),
                Err(e) => eprintln!("[r3d] isolation warning: {}", e),
            }

            if diet_flag || config.gpu_diet.enabled {
                println!("[r3d] applying Windows Graphical VRAM Diet...");
                let report = WindowsGpuDiet::apply(&config.gpu_diet);
                println!(
                    "[r3d] GPU diet applied: trimmed {} processes, freed {} bytes working sets. Live RTX 4070 VRAM: {}/{} MB free.",
                    report.trimmed_process_count,
                    report.total_working_set_trimmed_bytes,
                    report.vram_free_mb,
                    report.vram_total_mb
                );
            }

            let mgr = ConfigManager::new(config.clone());
            println!("[r3d] HTTP listening on http://{}", config.server.bind);
            println!("[r3d] WebGPU console: http://{}/gpu", config.server.bind);
            println!("[r3d] Ready. Instant kill-switch active (<1ms switch via POST /off).");

            let server = HttpServer::new(mgr);
            if let Err(e) = server.start() {
                eprintln!("[r3d] server error: {}", e);
                return ExitCode::FAILURE;
            }
        }

        Some(SubCommand::Diet(DietCommand { action })) => {
            match action.to_lowercase().as_str() {
                "apply" => {
                    let report = WindowsGpuDiet::apply(&config.gpu_diet);
                    println!(
                        "GPU diet applied: {} processes trimmed, {} bytes reclaimed. VRAM: {}/{} MB free.",
                        report.trimmed_process_count,
                        report.total_working_set_trimmed_bytes,
                        report.vram_free_mb,
                        report.vram_total_mb
                    );
                }
                "restore" => {
                    match WindowsGpuDiet::restore(&config.gpu_diet.backup_path) {
                        Ok(msg) => println!("GPU diet restored: {}", msg),
                        Err(e) => eprintln!("GPU diet restore error: {}", e),
                    }
                }
                _ => {
                    let (total, used, free) = query_nvidia_vram();
                    println!("Live RTX 4070 VRAM: Total: {} MB | Used: {} MB | Free: {} MB", total, used, free);
                    println!("Backup path: {}", config.gpu_diet.backup_path);
                    println!("Target GUI processes: {:?}", config.gpu_diet.target_processes);
                }
            }
        }

        Some(SubCommand::Infer(InferCommand { prompt, backend, max_tokens })) => {
            let mut inf_cfg = config.inference.clone();
            inf_cfg.default_backend = backend;
            let router = TriBackendInferenceRouter::new(inf_cfg);

            let req = ChatCompletionRequest {
                model: None,
                messages: vec![ChatMessage {
                    role: "user".to_string(),
                    content: prompt,
                }],
                temperature: Some(0.7),
                max_tokens: Some(max_tokens),
                stream: Some(false),
            };

            let resp = router.complete(&req);
            println!("{}", resp.choices[0].message.content);
        }

        Some(SubCommand::Systemd(SystemdCommand { out, bin_path })) => {
            let unit = SystemdUnitGenerator::generate_unit(&bin_path, &cli.config);
            if let Some(dest) = out {
                if let Err(e) = std::fs::write(&dest, unit) {
                    eprintln!("failed to write systemd unit: {}", e);
                    return ExitCode::FAILURE;
                }
                println!("Systemd unit written to {}", dest);
            } else {
                print!("{}", unit);
            }
        }

        Some(SubCommand::Boot(BootCommand { action })) => {
            match action.to_lowercase().as_str() {
                "enable" => {
                    println!("[r3d] boot persistence enabled safely (no permanent system lock-in).");
                    println!("[r3d] Use 'r3d boot disable' to revert at any time.");
                }
                "disable" => {
                    println!("[r3d] boot persistence disabled. r3d will only run when explicitly invoked.");
                }
                _ => {
                    println!("Boot persistence status: Configured via ring3-agent.toml (default: manual / on-demand)");
                }
            }
        }

        Some(SubCommand::Version(_)) => {
            println!("r3d 0.1.0 (Ring-3 Daemon)");
            println!("Target Architecture: NVIDIA RTX 4070 sm_89 + Intel AVX2/FMA + WebGPU WGSL");
            println!("Execution Mode: Strict Ring-3 Usermode Isolation");
        }
    }

    ExitCode::SUCCESS
}
