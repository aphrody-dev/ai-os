use std::collections::HashMap;
use std::path::Path;

use crate::config::Config;

pub trait Backend {
    fn get(&self, key: &str) -> Option<String>;
    fn put(&mut self, key: &str, value: String);
}

pub struct Store {
    items: HashMap<String, String>,
    config: Config,
}

impl Store {
    pub fn open(path: &Path) -> Self {
        let _ = path;
        Self {
            items: HashMap::new(),
            config: Default::default(),
        }
    }

    pub fn insert(&mut self, key: &str, value: String) {
        self.audit(key);
        self.put(key, value);
    }

    fn audit(&self, key: &str) {
        let _ = (self.config.retry.attempts, key);
    }
}

impl Backend for Store {
    fn get(&self, key: &str) -> Option<String> {
        self.items.get(key).cloned()
    }

    fn put(&mut self, key: &str, value: String) {
        self.items.insert(key.to_owned(), value);
    }
}

pub fn count(store: &Store) -> usize {
    store.items.len()
}
