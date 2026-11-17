//! Fixture crate of the Rust extractor parity test: small, self-contained and never compiled.

mod config;
mod net;
mod store;

use store::Store;

pub const GREETING: &str = "hello";
pub const MAX_ITEMS: usize = 8;

macro_rules! shout {
    ($text:expr) => {
        $text.to_uppercase()
    };
}

fn helper(store: &mut Store, name: &str) -> String {
    store.insert(name, name.to_owned());
    shout!(name)
}

pub fn run(config: &config::Config, store: &mut Store) -> usize {
    let line = helper(store, GREETING);
    store.insert(&line, config::Config::DEFAULT_LIMIT.to_string());
    MAX_ITEMS
}
