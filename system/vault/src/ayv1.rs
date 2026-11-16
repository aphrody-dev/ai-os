// SPDX-License-Identifier: Apache-2.0
//! AYV1 envelope: "AYV1" | flags u8 | wrapLen u16 BE | wrap | nonce[12] | ciphertext+tag.
//! Flag 1 (Windows Hello wrap) is produced and opened by the TS package only.

use crate::{Error, Result};
use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit};
use zeroize::Zeroizing;

const MAGIC: &[u8; 4] = b"AYV1";
const FLAG_HELLO: u8 = 1;

pub fn seal(master: &[u8; 32], aad: &str, plain: &[u8]) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(master).map_err(|_| Error::Crypto("key"))?;
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce).map_err(|_| Error::Crypto("rng"))?;
    let ct = cipher
        .encrypt(&nonce.into(), Payload { msg: plain, aad: aad.as_bytes() })
        .map_err(|_| Error::Crypto("seal"))?;
    let mut out = Vec::with_capacity(19 + ct.len());
    out.extend_from_slice(MAGIC);
    out.push(0);
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn open(master: &[u8; 32], aad: &str, env: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if env.len() < 19 + 16 || &env[..4] != MAGIC {
        return Err(Error::Crypto("not an AYV1 envelope"));
    }
    if env[4] & FLAG_HELLO != 0 {
        return Err(Error::Crypto("Windows Hello envelope: open it with @aphrody/vault"));
    }
    let wrap = u16::from_be_bytes([env[5], env[6]]) as usize;
    let nonce: [u8; 12] = env[7 + wrap..19 + wrap].try_into().map_err(|_| Error::Crypto("nonce"))?;
    let cipher = Aes256Gcm::new_from_slice(master).map_err(|_| Error::Crypto("key"))?;
    cipher
        .decrypt(&nonce.into(), Payload { msg: &env[19 + wrap..], aad: aad.as_bytes() })
        .map(Zeroizing::new)
        .map_err(|_| Error::Crypto("open"))
}
