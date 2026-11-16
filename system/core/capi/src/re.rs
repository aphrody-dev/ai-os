// SPDX-License-Identifier: Apache-2.0 OR MIT
//! C ABI surface for `aphrody-re` (binary triage, Ghidra P-Code/Pseudo-C, MinGW-REA,
//! and Lua 5.2 bytecode auditing/transcoding). Strings returned here must be freed with `aphrody_free`.

use std::os::raw::c_char;
use std::path::Path;

use serde_json::json;

use crate::cabi::{c_str, into_c_string, json_err, json_ok, raw_slice};
use aphrody_re::{
    ReEngine, SreAnalyzeOptions, analyze_binary_file, analyze_pe_mingw_rea,
    transcode_lua52_bytecode,
};

#[unsafe(no_mangle)]
pub extern "C" fn aphrody_re_audit_json(path_ptr: *const c_char) -> *mut c_char {
    // SAFETY: caller passes a NUL-terminated string valid for the call.
    let p_str = unsafe { c_str(path_ptr) };
    let path = Path::new(p_str);

    match ReEngine::audit_file(path) {
        Ok(audit) => json_ok(&audit),
        Err(e) => into_c_string(json!({ "error": e, "path": p_str }).to_string()),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn aphrody_re_audit_bytes_json(
    label_ptr: *const c_char,
    bytes_ptr: *const u8,
    bytes_len: usize,
) -> *mut c_char {
    // SAFETY: caller passes a NUL-terminated string and `bytes_len` readable bytes.
    let label = unsafe { c_str(label_ptr) };
    let slice = unsafe { raw_slice(bytes_ptr, bytes_len) };
    if slice.is_empty() {
        return into_c_string(json!({ "error": "empty bytecode buffer", "path": label }).to_string());
    }

    match ReEngine::audit_bytes(slice, label) {
        Ok(audit) => json_ok(&audit),
        Err(e) => into_c_string(json!({ "error": e, "path": label }).to_string()),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn aphrody_ghidra_decompile_json(
    path_ptr: *const c_char,
    max_functions: usize,
) -> *mut c_char {
    // SAFETY: caller passes a NUL-terminated string valid for the call.
    let p_str = unsafe { c_str(path_ptr) };
    let opts = SreAnalyzeOptions {
        max_functions: max_functions.max(1),
        ..SreAnalyzeOptions::default()
    };
    match analyze_binary_file(Path::new(p_str), &opts) {
        Ok(rep) => json_ok(&rep),
        Err(e) => into_c_string(json!({ "error": e, "path": p_str }).to_string()),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn aphrody_mingw_audit_json(
    path_ptr: *const c_char,
    max_functions: usize,
) -> *mut c_char {
    // SAFETY: caller passes a NUL-terminated string valid for the call.
    let p_str = unsafe { c_str(path_ptr) };
    match analyze_pe_mingw_rea(Path::new(p_str), max_functions.max(16)) {
        Ok(rep) => json_ok(&rep),
        Err(e) => into_c_string(json!({ "error": e, "path": p_str }).to_string()),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn aphrody_lua52_transcode_hex(
    bytes_ptr: *const u8,
    bytes_len: usize,
    target_int: u8,
    target_sizet: u8,
) -> *mut c_char {
    // SAFETY: caller guarantees `bytes_ptr` points to `bytes_len` readable bytes.
    let slice = unsafe { raw_slice(bytes_ptr, bytes_len) };
    if slice.is_empty() {
        return json_err("empty Lua 5.2 bytecode buffer");
    }

    match transcode_lua52_bytecode(slice, target_int, target_sizet) {
        Ok(out) => {
            let mut hex = String::with_capacity(out.len() * 2);
            for b in &out {
                use std::fmt::Write;
                let _ = write!(&mut hex, "{b:02x}");
            }
            into_c_string(
                json!({
                    "ok": true,
                    "byte_length": out.len(),
                    "target_size_int": target_int,
                    "target_size_size_t": target_sizet,
                    "hex": hex,
                })
                .to_string(),
            )
        }
        Err(e) => into_c_string(json!({ "ok": false, "error": e }).to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aphrody_free;
    use std::ffi::{CStr, CString};

    #[test]
    fn test_lua52_re_pipeline() {
        let luac_path = CString::new("quest.lua.bin").unwrap();
        let mut chunk = Vec::new();
        chunk.extend_from_slice(b"\x1bLua\x52\x00");
        chunk.extend_from_slice(&[1, 4, 8, 4, 8, 0]);
        chunk.extend_from_slice(b"\x19\x93\r\n\x1a\n");
        chunk.extend_from_slice(&0u32.to_le_bytes());
        chunk.extend_from_slice(&0u32.to_le_bytes());
        chunk.extend_from_slice(&[0, 1, 2]);
        let ret_instr = 31u32 | (1u32 << 23);
        chunk.extend_from_slice(&1u32.to_le_bytes());
        chunk.extend_from_slice(&ret_instr.to_le_bytes());
        chunk.extend_from_slice(&0u32.to_le_bytes());
        chunk.extend_from_slice(&0u32.to_le_bytes());
        chunk.extend_from_slice(&1u32.to_le_bytes());
        chunk.extend_from_slice(&[1, 0]);
        chunk.extend_from_slice(&0u64.to_le_bytes());
        chunk.extend_from_slice(&0u32.to_le_bytes());
        chunk.extend_from_slice(&0u32.to_le_bytes());
        chunk.extend_from_slice(&0u32.to_le_bytes());

        let audit_ptr = aphrody_re_audit_bytes_json(luac_path.as_ptr(), chunk.as_ptr(), chunk.len());
        let audit_str = unsafe { CStr::from_ptr(audit_ptr).to_str().unwrap() };
        assert!(audit_str.contains("\"is_lua_bytecode\":true"));
        assert!(audit_str.contains("RETURN"));
        unsafe { aphrody_free(audit_ptr) };

        let trans_ptr = aphrody_lua52_transcode_hex(chunk.as_ptr(), chunk.len(), 4, 4);
        let trans_str = unsafe { CStr::from_ptr(trans_ptr).to_str().unwrap() };
        assert!(trans_str.contains("\"ok\":true"));
        unsafe { aphrody_free(trans_ptr) };
    }
}
