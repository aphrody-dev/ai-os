//! Boq wire format from `corelib::web` over the C ABI (`aphrody_*` symbols). The adblock engine
//! has its own library, `src/adblock-capi` (`aphrody_adblock_*`).
//!
//! Every function returns a framed buffer that the caller releases with
//! `aphrody_chromium_buf_free`:
//! ```text
//! [u64 payload length, little endian][u8 status: 0 ok, 1 error][UTF-8 payload]
//! ```

use crate::cabi::{ABI_STATUS_ERR, ABI_STATUS_OK, free_framed, pack_framed, utf8_slice};
use corelib::boq_parse_envelopes;

/// Free a framed buffer returned by any `aphrody_*` C-ABI function.
///
/// # Safety
/// `ptr` must be null or a framed buffer returned by this library and not yet freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn aphrody_chromium_buf_free(ptr: *mut u8) {
    // SAFETY: caller guarantees `ptr` is null or an unfreed framed buffer from this library.
    unsafe { free_framed(ptr) };
}

/// Parse a Google Boq `batchexecute` response over C-ABI and return JSON array of envelopes.
///
/// # Safety
/// `raw_ptr` must be null/0 or point to `raw_len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn aphrody_boq_parse(raw_ptr: *const u8, raw_len: usize) -> *mut u8 {
    // SAFETY: caller guarantees `raw_ptr` points to `raw_len` readable bytes.
    let Some(text) = (unsafe { utf8_slice(raw_ptr, raw_len) }) else {
        return pack_framed(ABI_STATUS_ERR, b"boq input must be valid UTF-8");
    };
    let envelopes = boq_parse_envelopes(text);
    let serialized = serde_json::to_vec(&envelopes).unwrap_or_else(|_| b"[]".to_vec());
    pack_framed(ABI_STATUS_OK, &serialized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cabi::FRAMED_HEADER_LEN;

    /// Unpack a framed buffer, then free it through the exported destructor.
    fn take(ptr: *mut u8) -> (u8, String) {
        assert!(!ptr.is_null());
        unsafe {
            let mut len_bytes = [0u8; 8];
            std::ptr::copy_nonoverlapping(ptr, len_bytes.as_mut_ptr(), 8);
            let len = u64::from_le_bytes(len_bytes) as usize;
            let status = *ptr.add(8);
            let payload = std::slice::from_raw_parts(ptr.add(FRAMED_HEADER_LEN), len);
            let text = String::from_utf8(payload.to_vec()).unwrap();
            aphrody_chromium_buf_free(ptr);
            (status, text)
        }
    }

    #[test]
    fn boq_parse_rejects_invalid_utf8_and_accepts_empty_input() {
        let bad = [0xffu8, 0xfe];
        assert_eq!(take(unsafe { aphrody_boq_parse(bad.as_ptr(), bad.len()) }).0, 1);
        let (status, json) = take(unsafe { aphrody_boq_parse(std::ptr::null(), 0) });
        assert_eq!(status, 0);
        assert_eq!(json, "[]");
        unsafe { aphrody_chromium_buf_free(std::ptr::null_mut()) };
    }
}
