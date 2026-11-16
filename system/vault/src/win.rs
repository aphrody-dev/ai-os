// SPDX-License-Identifier: Apache-2.0
//! Win32 crypto (blocking: called through `spawn_blocking`).
//! DPAPI: CryptProtectData / CryptUnprotectData (crypt32), CRYPTPROTECT_UI_FORBIDDEN, v1 entropy.
//! DPAPI-NG: NCryptCreateProtectionDescriptor + NCryptProtectSecret / NCryptUnprotectSecret.

use crate::{Error, Result};
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData, NCRYPT_SILENT_FLAG, NCryptCloseProtectionDescriptor, NCryptCreateProtectionDescriptor, NCryptProtectSecret,
    NCryptUnprotectSecret,
};
use windows::Win32::Security::NCRYPT_DESCRIPTOR_HANDLE;
use windows::core::{HSTRING, PCWSTR};
use zeroize::{Zeroize, Zeroizing};

/// v1 entropy (env-kit); v2 passes "aphrody/vault/dpapi/v2|<NAME>" (see local.rs).
pub const ENTROPY: &[u8] = b"aphrody/env-kit/secret-store/v1";

fn blob(b: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB { cbData: b.len() as u32, pbData: b.as_ptr() as *mut u8 }
}

unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let s = unsafe { std::slice::from_raw_parts_mut(out.pbData, out.cbData as usize) };
    let v = s.to_vec();
    s.zeroize();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(out.pbData as _)));
    }
    v
}

pub fn dpapi_protect(data: &[u8], extra: &[u8]) -> Result<Vec<u8>> {
    let input = blob(data);
    let entropy = blob(extra);
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&input, PCWSTR::null(), Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            .map_err(|e| Error::Os(format!("CryptProtectData: {e}")))?;
        Ok(take(out))
    }
}

pub fn dpapi_unprotect(data: &[u8], extra: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let input = blob(data);
    let entropy = blob(extra);
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            .map_err(|e| Error::Os(format!("CryptUnprotectData: {e}")))?;
        Ok(Zeroizing::new(take(out)))
    }
}

/// DPAPI-NG with a protection descriptor ("LOCAL=user", "SID=S-1-5-21-…", "WEBCREDENTIALS=…").
pub fn ng_protect(descriptor: &str, data: &[u8]) -> Result<Vec<u8>> {
    unsafe {
        let h: NCRYPT_DESCRIPTOR_HANDLE = NCryptCreateProtectionDescriptor(&HSTRING::from(descriptor), 0)
            .map_err(|e| Error::Os(format!("NCryptCreateProtectionDescriptor: {e}")))?;
        let mut p: *mut u8 = std::ptr::null_mut();
        let mut n: u32 = 0;
        let r = NCryptProtectSecret(h, NCRYPT_SILENT_FLAG.0, data, None, None, &mut p, &mut n);
        let _ = NCryptCloseProtectionDescriptor(h);
        r.map_err(|e| Error::Os(format!("NCryptProtectSecret: {e}")))?;
        Ok(take(CRYPT_INTEGER_BLOB { cbData: n, pbData: p }))
    }
}

pub fn ng_unprotect(data: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    unsafe {
        let mut p: *mut u8 = std::ptr::null_mut();
        let mut n: u32 = 0;
        NCryptUnprotectSecret(None, NCRYPT_SILENT_FLAG, data, None, None, &mut p, &mut n)
            .map_err(|e| Error::Os(format!("NCryptUnprotectSecret: {e}")))?;
        Ok(Zeroizing::new(take(CRYPT_INTEGER_BLOB { cbData: n, pbData: p })))
    }
}
