use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub isolation: IsolationConfig,
    pub gpu_diet: GpuDietConfig,
    pub inference: InferenceConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub bind: String,
    pub workers: usize,
    pub enabled: bool,
    pub instant_disable_timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IsolationConfig {
    pub ring: String,
    pub pid_strategy: String,
    pub target_min_pid: u32,
    pub max_memory_mb: u64,
    pub cpu_affinity_mask: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuDietConfig {
    pub enabled: bool,
    pub trim_working_sets: bool,
    pub disable_ui_effects: bool,
    pub eco_qos_background_renderers: bool,
    pub backup_path: String,
    pub target_processes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceConfig {
    pub default_backend: String,
    pub cuda_device_id: usize,
    pub cuda_target: String,
    pub max_context_tokens: usize,
    pub kv_cache_budget_mb: usize,
    pub vps_threads: usize,
    pub temperature: f32,
    pub top_p: f32,
    #[serde(default)]
    pub models: Vec<ModelCatalogItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelCatalogItem {
    pub id: String,
    pub backend: String,
    pub context: usize,
    pub description: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            server: ServerConfig {
                bind: "127.0.0.1:8080".to_string(),
                workers: 4,
                enabled: true,
                instant_disable_timeout_ms: 1,
            },
            isolation: IsolationConfig {
                ring: "ring3-litebox".to_string(),
                pid_strategy: "upper-namespace".to_string(),
                target_min_pid: 3000000,
                max_memory_mb: 4096,
                cpu_affinity_mask: 0,
            },
            gpu_diet: GpuDietConfig {
                enabled: true,
                trim_working_sets: true,
                disable_ui_effects: true,
                eco_qos_background_renderers: true,
                backup_path: "gpu-diet-backup.json".to_string(),
                target_processes: vec![
                    "msedgewebview2.exe".to_string(),
                    "SearchHost.exe".to_string(),
                    "TextInputHost.exe".to_string(),
                    "WWAHost.exe".to_string(),
                    "ShellExperienceHost.exe".to_string(),
                    "StartMenuExperienceHost.exe".to_string(),
                    "explorer.exe".to_string(),
                ],
            },
            inference: InferenceConfig {
                default_backend: "auto".to_string(),
                cuda_device_id: 0,
                cuda_target: "sm_89".to_string(),
                max_context_tokens: 8192,
                kv_cache_budget_mb: 6144,
                vps_threads: 8,
                temperature: 0.7,
                top_p: 0.9,
                models: vec![
                    ModelCatalogItem {
                        id: "r3d-q8-nano".to_string(),
                        backend: "vps-cpu-avx2".to_string(),
                        context: 4096,
                        description: "Ring-3 AVX2/FMA Quantized CPU Transformer".to_string(),
                    },
                    ModelCatalogItem {
                        id: "r3d-ada-sm89".to_string(),
                        backend: "cuda-sm89".to_string(),
                        context: 16384,
                        description: "NVIDIA RTX 4070 Ada Lovelace Tensor-Core Engine".to_string(),
                    },
                    ModelCatalogItem {
                        id: "r3d-webgpu-edge".to_string(),
                        backend: "webgpu-wgsl".to_string(),
                        context: 4096,
                        description: "Client Browser In-Memory WGSL Compute Engine".to_string(),
                    },
                ],
            },
        }
    }
}

impl AppConfig {
    pub fn load_from_path<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        let path_ref = path.as_ref();
        if !path_ref.exists() {
            return Ok(Self::default());
        }
        let content = fs::read_to_string(path_ref)
            .map_err(|e| format!("failed to read config file {}: {}", path_ref.display(), e))?;
        toml::from_str(&content)
            .map_err(|e| format!("failed to parse TOML in {}: {}", path_ref.display(), e))
    }

    pub fn save_to_path<P: AsRef<Path>>(&self, path: P) -> Result<(), String> {
        let content = toml::to_string_pretty(self)
            .map_err(|e| format!("failed to serialize config to TOML: {}", e))?;
        fs::write(path.as_ref(), content)
            .map_err(|e| format!("failed to write config to {}: {}", path.as_ref().display(), e))
    }
}

/// Thread-safe controller for runtime instant disable/enable and hot reload.
#[derive(Clone)]
pub struct ConfigManager {
    inner: Arc<std::sync::RwLock<AppConfig>>,
    enabled: Arc<AtomicBool>,
}

impl ConfigManager {
    pub fn new(config: AppConfig) -> Self {
        let enabled = Arc::new(AtomicBool::new(config.server.enabled));
        Self {
            inner: Arc::new(std::sync::RwLock::new(config)),
            enabled,
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    pub fn set_enabled(&self, val: bool) {
        self.enabled.store(val, Ordering::Release);
        if let Ok(mut lock) = self.inner.write() {
            lock.server.enabled = val;
        }
    }

    pub fn get_config(&self) -> AppConfig {
        self.inner.read().unwrap().clone()
    }

    pub fn update_config(&self, new_config: AppConfig) {
        self.enabled.store(new_config.server.enabled, Ordering::Release);
        if let Ok(mut lock) = self.inner.write() {
            *lock = new_config;
        }
    }
}
