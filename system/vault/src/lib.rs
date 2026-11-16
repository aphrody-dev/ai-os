// SPDX-License-Identifier: Apache-2.0
//! aphrody-vault: async Rust API over the vault of src, byte-compatible
//! with the TS package `@aphrody/vault`:
//!
//! - local layer: DPAPI user scope with the v1 entropy (Windows, `spawn_blocking`), or
//!   `systemd-creds [--user]` (Linux, `tokio::process`), one file per secret;
//! - DPAPI-NG (`NCryptProtectSecret`) with a protection descriptor such as `LOCAL=user`;
//! - AYV1 envelopes (AES-256-GCM, AAD bound) keyed by the vault master key;
//! - age X25519 envelopes (crate `age`), one recipient per host.
//!
//! Values are `Zeroizing<Vec<u8>>`; nothing is logged. `capi` exposes a C ABI for bun:ffi.

pub mod ayv1;
pub mod capi;
pub mod envelope;
pub mod local;
#[cfg(windows)]
pub mod win;

pub use ayv1::{open, seal};
pub use envelope::{age_decrypt, age_encrypt};
pub use local::{get_secret, has_secret, list_secrets, set_secret, store_info, Backend, StoreInfo};

#[derive(Debug)]
pub enum Error {
    InvalidName(String),
    NotFound(String),
    Crypto(&'static str),
    Os(String),
    Io(std::io::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::InvalidName(n) => write!(f, "invalid secret name: {n:?}"),
            Error::NotFound(n) => write!(f, "secret absent: {n}"),
            Error::Crypto(w) => write!(f, "crypto: {w}"),
            Error::Os(w) => write!(f, "os: {w}"),
            Error::Io(e) => write!(f, "io: {e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// `^[A-Za-z_][A-Za-z0-9_.-]{0,127}$`, same rule as the TS store.
pub fn valid_name(n: &str) -> bool {
    let b = n.as_bytes();
    !b.is_empty()
        && b.len() <= 128
        && (b[0].is_ascii_alphabetic() || b[0] == b'_')
        && b[1..].iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
}
