// SPDX-License-Identifier: Apache-2.0
//! C ABI for bun:ffi (`dlopen("aphrody_vault.dll" | "libaphrody_vault.so")`). Each call blocks
//! its caller on a shared multi-thread tokio runtime: call it from a bun Worker, never from the
//! main event loop. Returns 0 on success, -1 on error (`aphrody_vault_last_error`), 1 if absent.
//! Buffers returned through `out`/`out_len` are freed (and zeroed) by `aphrody_vault_free`.

use crate::{Error, local};
use std::cell::RefCell;
use std::ffi::{CStr, CString, c_char};
use std::sync::OnceLock;
use zeroize::Zeroize;

fn rt() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio runtime"))
}

thread_local! { static LAST: RefCell<CString> = RefCell::new(CString::default()); }

fn fail(e: Error) -> i32 {
    LAST.with(|l| *l.borrow_mut() = CString::new(e.to_string().replace('\0', " ")).unwrap_or_default());
    if matches!(e, Error::NotFound(_)) { 1 } else { -1 }
}

unsafe fn give(v: Vec<u8>, out: *mut *mut u8, out_len: *mut usize) {
    let b = v.into_boxed_slice();
    unsafe {
        *out_len = b.len();
        *out = Box::into_raw(b) as *mut u8;
    }
}

unsafe fn str_arg<'a>(p: *const c_char) -> Result<&'a str, Error> {
    if p.is_null() {
        return Err(Error::InvalidName("null".into()));
    }
    unsafe { CStr::from_ptr(p) }.to_str().map_err(|_| Error::InvalidName("utf-8".into()))
}

unsafe fn bytes_arg<'a>(p: *const u8, n: usize) -> &'a [u8] {
    if p.is_null() || n == 0 { &[] } else { unsafe { std::slice::from_raw_parts(p, n) } }
}

#[unsafe(no_mangle)]
pub extern "C" fn aphrody_vault_last_error() -> *const c_char {
    LAST.with(|l| l.borrow().as_ptr())
}

/// # Safety
/// `p`/`n` must come from an `out`/`out_len` pair of this library.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn aphrody_vault_free(p: *mut u8, n: usize) {
    if !p.is_null() {
        let mut b = unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(p, n)) };
        b.zeroize();
    }
}

/// # Safety
/// `name` NUL-terminated; `out`, `out_len` valid pointers.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn aphrody_vault_get_secret(name: *const c_char, out: *mut *mut u8, out_len: *mut usize) -> i32 {
    let name = match unsafe { str_arg(name) } {
        Ok(n) => n,
        Err(e) => return fail(e),
    };
    match rt().block_on(local::get_secret(name)) {
        Ok(v) => unsafe { give(v.to_vec(), out, out_len); 0 },
        Err(e) => fail(e),
    }
}

/// # Safety
/// `name` NUL-terminated; `value` readable for `len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn aphrody_vault_set_secret(name: *const c_char, value: *const u8, len: usize) -> i32 {
    let name = match unsafe { str_arg(name) } {
        Ok(n) => n,
        Err(e) => return fail(e),
    };
    match rt().block_on(local::set_secret(name, unsafe { bytes_arg(value, len) })) {
        Ok(()) => 0,
        Err(e) => fail(e),
    }
}

/// age envelope to newline-separated X25519 recipients.
/// # Safety
/// `recipients` NUL-terminated; `data` readable for `len`; `out`, `out_len` valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn aphrody_vault_age_encrypt(
    recipients: *const c_char, data: *const u8, len: usize, out: *mut *mut u8, out_len: *mut usize,
) -> i32 {
    let rs = match unsafe { str_arg(recipients) } {
        Ok(r) => r.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect::<Vec<_>>(),
        Err(e) => return fail(e),
    };
    match crate::envelope::encrypt_blocking(unsafe { bytes_arg(data, len) }, &rs) {
        Ok(v) => unsafe { give(v, out, out_len); 0 },
        Err(e) => fail(e),
    }
}

/// AYV1 seal / open with the vault master key (`VAULT_MASTER_KEY` of the local layer).
/// # Safety
/// `aad` NUL-terminated; `data` readable for `len`; `out`, `out_len` valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn aphrody_vault_seal(aad: *const c_char, data: *const u8, len: usize, out: *mut *mut u8, out_len: *mut usize) -> i32 {
    unsafe { ayv1_call(true, aad, data, len, out, out_len) }
}

/// # Safety
/// Same contract as `aphrody_vault_seal`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn aphrody_vault_open(aad: *const c_char, data: *const u8, len: usize, out: *mut *mut u8, out_len: *mut usize) -> i32 {
    unsafe { ayv1_call(false, aad, data, len, out, out_len) }
}

unsafe fn ayv1_call(seal: bool, aad: *const c_char, data: *const u8, len: usize, out: *mut *mut u8, out_len: *mut usize) -> i32 {
    let aad = match unsafe { str_arg(aad) } {
        Ok(a) => a,
        Err(e) => return fail(e),
    };
    let master = match rt().block_on(local::get_secret("VAULT_MASTER_KEY")) {
        Ok(m) if m.len() == 32 => {
            let mut k = [0u8; 32];
            k.copy_from_slice(&m);
            zeroize::Zeroizing::new(k)
        }
        Ok(_) => return fail(Error::Crypto("master key length")),
        Err(e) => return fail(e),
    };
    let input = unsafe { bytes_arg(data, len) };
    let r = if seal { crate::ayv1::seal(&master, aad, input) } else { crate::ayv1::open(&master, aad, input).map(|v| v.to_vec()) };
    match r {
        Ok(v) => unsafe { give(v, out, out_len); 0 },
        Err(e) => fail(e),
    }
}
