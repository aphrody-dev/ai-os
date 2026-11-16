use std::os::raw::c_char;
use std::path::Path;
use serde_json::json;

use aphrody_core::{SupportedLanguage, apply_helix_rope_edits};
use crate::cabi::{c_str, free_c_string, into_c_string, json_err, json_ok, raw_slice};
use depot_core::{GixEngine, JustEngine, detect_content};
use depot_forge::GitHubClient;
use depot_graph::{GraphQuery, QueryOptions, build_graph_for_dir};
use depot_ingest::{DigestFormat, IngestConfig, ingest_codebase};
use depot_migrate::{
    MigrateEngine, generate_dotnet_rust_bun_bindings, parse_llvm_ir_text,
    probe_dotnet_environment, probe_llvm_rust_bun_toolchain, transform_source,
};

pub const DEPOT_ABI_VERSION: u32 = 20261111;

#[unsafe(no_mangle)]
pub extern "C" fn depot_abi_version() -> u32 {
    DEPOT_ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn depot_free_string(ptr: *mut c_char) {
    // SAFETY: `ptr` is null or was produced by `into_c_string` in this library.
    unsafe { free_c_string(ptr) };
}

#[unsafe(no_mangle)]
pub extern "C" fn depot_gix_status_json(path_ptr: *const c_char) -> *mut c_char {
    // SAFETY: caller passes a NUL-terminated string valid for the call.
    let p_str = unsafe { c_str(path_ptr) };
    let path = if p_str.is_empty() { Path::new(".") } else { Path::new(p_str) };

    match GixEngine::inspect(path, 10) {
        Ok(telemetry) => json_ok(&telemetry),
        Err(e) => json_err(e),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn depot_just_recipes_json(justfile_path_ptr: *const c_char) -> *mut c_char {
    // SAFETY: caller passes a NUL-terminated string valid for the call.
    let p_str = unsafe { c_str(justfile_path_ptr) };
    let path = if p_str.is_empty() { Path::new("justfile") } else { Path::new(p_str) };

    match JustEngine::parse_file(path) {
        Ok(spec) => json_ok(&spec),
        Err(e) => json_err(e),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn depot_ingest_json(
    root_dir_ptr: *const c_char,
    max_tokens: u32,
    outline_only: bool,
) -> *mut c_char {
    // SAFETY: caller passes a NUL-terminated string valid for the call.
    let r_str = unsafe { c_str(root_dir_ptr) };
    let path = if r_str.is_empty() { Path::new(".") } else { Path::new(r_str) };

    let mut config = IngestConfig::default();
    if max_tokens > 0 {
        config.max_tokens = Some(max_tokens as usize);
    }
    config.outline_only = outline_only;
    config.format = DigestFormat::Json;

    let (digest, stats) = ingest_codebase(path, &config);
    into_c_string(
        json!({
            "stats": stats,
            "digest": digest
        })
        .to_string(),
    )
}

#[unsafe(no_mangle)]
pub extern "C" fn depot_graph_query_json(
    graph_dir_ptr: *const c_char,
    term_ptr: *const c_char,
    dfs: bool,
    max_tokens: u32,
) -> *mut c_char {
    // SAFETY: caller passes NUL-terminated strings valid for the call.
    let g_str = unsafe { c_str(graph_dir_ptr) };
    let path = if g_str.is_empty() { Path::new(".") } else { Path::new(g_str) };
    let term = unsafe { c_str(term_ptr) };

    let graph = build_graph_for_dir(path, &[]);
    let opts = QueryOptions {
        dfs,
        max_tokens: if max_tokens == 0 { 2000 } else { max_tokens as usize },
        max_depth: 3,
    };

    let context = GraphQuery::query(&graph, term, &opts);
    into_c_string(
        json!({
            "term": term,
            "mode": if dfs { "dfs" } else { "bfs" },
            "context": context
        })
        .to_string(),
    )
}

#[unsafe(no_mangle)]
pub extern "C" fn depot_forge_repo_json(
    owner_ptr: *const c_char,
    repo_ptr: *const c_char,
) -> *mut c_char {
    // SAFETY: caller passes NUL-terminated strings valid for the call.
    let owner = unsafe { c_str(owner_ptr) };
    let repo = unsafe { c_str(repo_ptr) };

    let client = GitHubClient::from_vault();
    match client.get_repo(owner, repo) {
        Ok(r) => json_ok(&r),
        Err(e) => json_err(e),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn depot_magika_detect_json(
    path_ptr: *const c_char,
    bytes_ptr: *const u8,
    bytes_len: usize,
) -> *mut c_char {
    // SAFETY: caller passes a NUL-terminated string and `bytes_len` readable bytes.
    let p_str = unsafe { c_str(path_ptr) };
    let path = Path::new(p_str);
    let slice = unsafe { raw_slice(bytes_ptr, bytes_len) };

    let sig = detect_content(path, slice);
    json_ok(&sig)
}

#[unsafe(no_mangle)]
pub extern "C" fn depot_helix_rope_edit(
    source_ptr: *const c_char,
    edits_json_ptr: *const c_char,
) -> *mut c_char {
    // SAFETY: caller passes NUL-terminated strings valid for the call.
    let source = unsafe { c_str(source_ptr) };
    let edits_str = unsafe { c_str(edits_json_ptr) };

    // Parse array of [start_byte, end_byte, replacement]
    let parsed: Result<Vec<(usize, usize, String)>, _> = serde_json::from_str(edits_str);
    match parsed {
        Ok(edits) => into_c_string(apply_helix_rope_edits(source, edits)),
        Err(e) => into_c_string(format!("Error: {e}")),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn depot_migrate_run_json(root_dir_ptr: *const c_char, dry_run: bool) -> *mut c_char {
    // SAFETY: caller passes a NUL-terminated string valid for the call.
    let r_str = unsafe { c_str(root_dir_ptr) };
    let path = if r_str.is_empty() { Path::new(".") } else { Path::new(r_str) };

    match MigrateEngine::run(path, dry_run) {
        Ok(rep) => json_ok(&rep),
        Err(e) => json_err(e),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn depot_dotnet_doctor_json() -> *mut c_char {
    match probe_dotnet_environment() {
        Ok(rep) => json_ok(&rep),
        Err(e) => json_err(e),
    }
}

fn resolve_transform_language(spec: &str) -> Option<SupportedLanguage> {
    let trimmed = spec.trim().trim_start_matches('.');
    match trimmed.to_ascii_lowercase().as_str() {
        "ts" | "mts" | "cts" | "typescript" => Some(SupportedLanguage::TypeScript),
        "tsx" => Some(SupportedLanguage::Tsx),
        "js" | "mjs" | "cjs" | "jsx" | "javascript" => Some(SupportedLanguage::JavaScript),
        "lua" => Some(SupportedLanguage::Lua),
        _ => SupportedLanguage::from_path(Path::new(trimmed))
            .or_else(|| SupportedLanguage::from_path(Path::new(&format!("input.{trimmed}")))),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn depot_transform_source_json(
    lang_or_path_ptr: *const c_char,
    source_ptr: *const c_char,
) -> *mut c_char {
    // SAFETY: caller passes NUL-terminated strings valid for the call.
    let lang_spec = unsafe { c_str(lang_or_path_ptr) };
    let source = unsafe { c_str(source_ptr) };
    let Some(lang) = resolve_transform_language(lang_spec) else {
        return json_err(format!("unsupported transform language: {lang_spec}"));
    };
    json_ok(&transform_source(lang, source))
}

#[unsafe(no_mangle)]
pub extern "C" fn depot_llvm_probe_json(vendor_llvm_dir_ptr: *const c_char) -> *mut c_char {
    // SAFETY: caller passes a NUL-terminated string valid for the call.
    let dir_str = unsafe { c_str(vendor_llvm_dir_ptr) };
    let path = if dir_str.is_empty() {
        Path::new("third_party/llvm-project")
    } else {
        Path::new(dir_str)
    };
    json_ok(&probe_llvm_rust_bun_toolchain(path))
}

#[unsafe(no_mangle)]
pub extern "C" fn depot_llvm_ir_analyze_json(
    source_label_ptr: *const c_char,
    ir_text_ptr: *const c_char,
) -> *mut c_char {
    // SAFETY: caller passes NUL-terminated strings valid for the call.
    let label = unsafe { c_str(source_label_ptr) };
    let ir_text = unsafe { c_str(ir_text_ptr) };
    let safe_label = if label.is_empty() { "module.ll" } else { label };
    json_ok(&parse_llvm_ir_text(ir_text, safe_label))
}

#[unsafe(no_mangle)]
pub extern "C" fn depot_dotnet_bindgen_json(
    cs_path_ptr: *const c_char,
    assembly_name_ptr: *const c_char,
) -> *mut c_char {
    // SAFETY: caller passes NUL-terminated strings valid for the call.
    let cs_path = unsafe { c_str(cs_path_ptr) };
    let assembly_name = unsafe { c_str(assembly_name_ptr) };
    let asm = if assembly_name.is_empty() {
        "AphrodyNative"
    } else {
        assembly_name
    };
    match generate_dotnet_rust_bun_bindings(Path::new(cs_path), asm) {
        Ok(bundle) => json_ok(&bundle),
        Err(e) => into_c_string(json!({ "error": e, "path": cs_path }).to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::{CStr, CString};

    #[test]
    fn test_abi_version() {
        assert_eq!(depot_abi_version(), DEPOT_ABI_VERSION);
    }

    #[test]
    fn test_helix_rope_ffi() {
        let code = CString::new("fn hello() { return 1; }").unwrap();
        let edits = CString::new(r#"[[3, 8, "world"], [20, 21, "42"]]"#).unwrap();

        let res_ptr = depot_helix_rope_edit(code.as_ptr(), edits.as_ptr());
        assert!(!res_ptr.is_null());
        let res_str = unsafe { CStr::from_ptr(res_ptr).to_str().unwrap() };
        assert_eq!(res_str, "fn world() { return 42; }");
        depot_free_string(res_ptr);
    }

    #[test]
    fn test_magika_detect_ffi() {
        let path = CString::new("index.ts").unwrap();
        let sample = b"export const x: number = 42;";
        let res_ptr = depot_magika_detect_json(path.as_ptr(), sample.as_ptr(), sample.len());
        assert!(!res_ptr.is_null());
        let res_str = unsafe { CStr::from_ptr(res_ptr).to_str().unwrap() };
        assert!(res_str.contains("typescript"));
        depot_free_string(res_ptr);
    }

    #[test]
    fn test_magika_lua52_detect_ffi() {
        let luac_path = CString::new("quest.lua.bin").unwrap();
        let mut chunk = Vec::new();
        chunk.extend_from_slice(b"\x1bLua\x52\x00");
        chunk.extend_from_slice(&[1, 4, 8, 4, 8, 0]);
        chunk.extend_from_slice(b"\x19\x93\r\n\x1a\n");
        chunk.extend_from_slice(&0u32.to_le_bytes());

        let magika_ptr = depot_magika_detect_json(luac_path.as_ptr(), chunk.as_ptr(), chunk.len());
        let magika_str = unsafe { CStr::from_ptr(magika_ptr).to_str().unwrap() };
        assert!(magika_str.contains("LuaBytecode"));
        depot_free_string(magika_ptr);
    }

    #[test]
    fn test_transform_and_llvm_ir_ffi() {
        let lang = CString::new("ts").unwrap();
        let src = CString::new("import { readFileSync } from 'fs';\nexport const n = 1;").unwrap();
        let res_ptr = depot_transform_source_json(lang.as_ptr(), src.as_ptr());
        let res_str = unsafe { CStr::from_ptr(res_ptr).to_str().unwrap() };
        assert!(res_str.contains("node:fs"));
        depot_free_string(res_ptr);

        let label = CString::new("vec.ll").unwrap();
        let ir = CString::new("target triple = \"x86_64-pc-windows-msvc\"\ndefine void @vadd() nounwind {\nentry:\n  %1 = add <8 x i32> zeroinitializer, zeroinitializer\n  ret void\n}\n").unwrap();
        let ir_ptr = depot_llvm_ir_analyze_json(label.as_ptr(), ir.as_ptr());
        let ir_str = unsafe { CStr::from_ptr(ir_ptr).to_str().unwrap() };
        assert!(ir_str.contains("\"total_functions\":1"));
        assert!(ir_str.contains("\"simd_vectorized_functions\":1"));
        depot_free_string(ir_ptr);
    }
}
