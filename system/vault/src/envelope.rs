// SPDX-License-Identifier: Apache-2.0
//! age X25519 envelopes (one recipient per host), CPU work on the blocking pool.

use crate::{Error, Result};
use std::io::{Read, Write};
use std::str::FromStr;
use zeroize::Zeroizing;

fn encrypt_sync(plain: &[u8], recipients: &[String]) -> Result<Vec<u8>> {
    let rs: Vec<age::x25519::Recipient> = recipients
        .iter()
        .map(|r| age::x25519::Recipient::from_str(r).map_err(|_| Error::Crypto("recipient")))
        .collect::<Result<_>>()?;
    let enc = age::Encryptor::with_recipients(rs.iter().map(|r| r as &dyn age::Recipient))
        .map_err(|_| Error::Crypto("no recipient"))?;
    let mut out = Vec::new();
    let mut w = enc.wrap_output(&mut out).map_err(Error::Io)?;
    w.write_all(plain)?;
    w.finish()?;
    Ok(out)
}

fn decrypt_sync(env: &[u8], identity: &str) -> Result<Zeroizing<Vec<u8>>> {
    let line = identity
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("AGE-SECRET-KEY-1"))
        .ok_or(Error::Crypto("identity"))?;
    let id = age::x25519::Identity::from_str(line).map_err(|_| Error::Crypto("identity"))?;
    let dec = age::Decryptor::new(env).map_err(|_| Error::Crypto("envelope"))?;
    let mut r = dec
        .decrypt(std::iter::once(&id as &dyn age::Identity))
        .map_err(|_| Error::Crypto("decrypt"))?;
    let mut out = Zeroizing::new(Vec::new());
    r.read_to_end(&mut out)?;
    Ok(out)
}

pub async fn age_encrypt(plain: Zeroizing<Vec<u8>>, recipients: Vec<String>) -> Result<Vec<u8>> {
    tokio::task::spawn_blocking(move || encrypt_sync(&plain, &recipients))
        .await
        .map_err(|_| Error::Os("join".into()))?
}

pub async fn age_decrypt(env: Vec<u8>, identity: Zeroizing<String>) -> Result<Zeroizing<Vec<u8>>> {
    tokio::task::spawn_blocking(move || decrypt_sync(&env, &identity))
        .await
        .map_err(|_| Error::Os("join".into()))?
}

#[doc(hidden)]
pub fn encrypt_blocking(plain: &[u8], recipients: &[String]) -> Result<Vec<u8>> {
    encrypt_sync(plain, recipients)
}
#[doc(hidden)]
pub fn decrypt_blocking(env: &[u8], identity: &str) -> Result<Zeroizing<Vec<u8>>> {
    decrypt_sync(env, identity)
}
