use std::path::PathBuf;

pub struct Retry {
    pub attempts: u32,
}

pub enum Mode {
    Fast,
    Careful(Retry),
    Custom(PathBuf),
}

pub struct Config {
    pub mode: Mode,
    pub retry: Retry,
}

impl Config {
    pub const DEFAULT_LIMIT: usize = 16;

    pub fn default(retry: Option<Retry>) -> Self {
        Config {
            mode: Mode::Fast,
            retry: retry.unwrap_or(Retry { attempts: 3 }),
        }
    }

    pub fn with_mode(mut self, mode: Mode) -> Self {
        self.mode = mode;
        self
    }
}
