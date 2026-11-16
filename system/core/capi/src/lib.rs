//! C ABI over `aphrody-core`, shipped as `aphrody_core_capi.dll` / `libaphrody_core_capi.so`.
//!
//! One C ABI for the monorepo's native libraries (merged with the former `aphrody_ffi`).
//! Surfaces, each behind a default feature so a consumer can build a smaller library with
//! `--no-default-features --features <surface>`:
//! - `core` / `pipeline`: `core_*` (tree-sitter, BLAKE3, index, in-process index pipeline).
//! - `ai-os`: `ai_os_*` (VFS, RAG, world model, System 1).
//! - `depot`: `depot_*`, the native depot contract (`system/depot*`); strings released with
//!   `depot_free_string` or `aphrody_free`; `depot_abi_version` returns [`depot::DEPOT_ABI_VERSION`].
//! - `re`: `aphrody_re_*`, `aphrody_ghidra_*`, `aphrody_mingw_*`, `aphrody_lua52_*` (`frameworks/re`).
//! - `web`: `aphrody_*` from `corelib::web` (Boq parser; the adblock engine is
//!   `src/adblock-capi`); framed buffers released with `aphrody_chromium_buf_free`.
//! Symbol names are a stable contract with their consumers and never change.
//!
//! Contract (mirrored by `system/core-ts/src/ffi.ts` and `include/aphrody_core.h`):
//! - Strings in are NUL-terminated UTF-8; strings out are NUL-terminated UTF-8 JSON owned by
//!   the library and released with [`core_free`] or [`aphrody_free`].
//! - Errors come back as `{"error": "..."}` JSON; null only when the output holds a NUL byte.
//! - Build with the shared LLVM toolchain (docs/llvm/UNIFIED-TOOLCHAIN.md) for cross-language LTO.

/// Common C ABI primitives, one copy in aphrody-labs/open `crates/c-abi`; it also exports
/// `aphrody_abi_version` and `aphrody_free`.
pub use c_abi as cabi;
pub use c_abi::{aphrody_abi_version, aphrody_free};
pub mod sys;
#[cfg(feature = "ai-os")]
pub mod ai_os;
#[cfg(feature = "depot")]
pub mod depot;
pub mod mwg;
#[cfg(feature = "re")]
pub mod re;
#[cfg(feature = "web")]
pub mod web;

#[cfg(feature = "core")]
mod core_exports {
    use crate::cabi::{
        self, APHRODY_ABI_VERSION, AphrodySlice, AphrodyStatus, c_str, free_c_string, into_c_string,
        json_err, json_ok, raw_slice,
    };
    use aphrody_core::{SupportedLanguage, TreeSitterEngine, hash, index};
    use std::ffi::{CString, c_char};
    use std::path::{Path, PathBuf};

    /// Bumped on any signature change.
    pub const CORE_ABI_VERSION: u32 = APHRODY_ABI_VERSION;

    /// Per-file callback for [`core_index_each`]: one `IndexedFile` JSON, borrowed for the call.
    pub type CoreFileCallback = extern "C" fn(file_json: *const c_char);

    /// Core C ABI version (alias of [`crate::aphrody_abi_version`]).
    #[unsafe(no_mangle)]
    pub extern "C" fn core_abi_version() -> u32 {
        CORE_ABI_VERSION
    }

    /// Release a string returned by any `core_*` function. Null is a no-op.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_free(p: *mut c_char) {
        // SAFETY: `p` is null or was produced by `into_c_string` in this library.
        unsafe { free_c_string(p) };
    }

    /// Comma-separated tree-sitter grammars compiled in.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_languages() -> *mut c_char {
        into_c_string(
            SupportedLanguage::ALL
                .iter()
                .map(|l| l.name())
                .collect::<Vec<_>>()
                .join(","),
        )
    }

    /// Parse `content` (grammar picked from `path`) into an `AstFileSummary` JSON.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_parse_json(path: *const c_char, content: *const c_char) -> *mut c_char {
        // SAFETY: caller passes NUL-terminated strings valid for the call.
        let path_str = unsafe { c_str(path) };
        let content_str = unsafe { c_str(content) };
        match TreeSitterEngine::parse_file(Path::new(path_str), content_str) {
            Some(summary) => json_ok(&summary),
            None => json_err(format!("unsupported language or parse failure: {path_str}")),
        }
    }

    /// Run a tree-sitter S-expression query; `path` only selects the grammar.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_query_json(
        path: *const c_char,
        content: *const c_char,
        query: *const c_char,
    ) -> *mut c_char {
        // SAFETY: caller passes NUL-terminated strings valid for the call.
        let path_str = unsafe { c_str(path) };
        let Some(lang) = TreeSitterEngine::detect_language(Path::new(path_str)) else {
            return json_err("unsupported language");
        };
        let content_str = unsafe { c_str(content) };
        let query_str = unsafe { c_str(query) };
        match TreeSitterEngine::query_sexpr(lang, content_str, query_str) {
            Ok(caps) => json_ok(&caps),
            Err(e) => json_err(e),
        }
    }

    /// Facts of one file (`aphrody_core::facts`): comments, strings, imports, calls, Markdown blocks. `query` is
    /// null or empty for the built-in facts query of the grammar picked from `path`, else an S-expression query.
    /// Returns a `FileMatches` JSON (short keys, see the module docs of `aphrody_core::facts`).
    #[unsafe(no_mangle)]
    pub extern "C" fn core_facts_json(
        path: *const c_char,
        content: *const c_char,
        query: *const c_char,
    ) -> *mut c_char {
        use aphrody_core::facts::{Engine, Lang, Selector, scan_content};
        // SAFETY: caller passes NUL-terminated strings valid for the call; `query` may be null.
        let path_str = unsafe { c_str(path) };
        let content_str = unsafe { c_str(content) };
        let custom = if query.is_null() { "" } else { unsafe { c_str(query) } };
        let Some(lang) = Lang::for_path(Path::new(path_str)) else {
            return json_err(format!("unsupported language: {path_str}"));
        };
        let selector = if custom.is_empty() { Selector::Facts } else { Selector::Custom(custom.to_string()) };
        json_ok(&scan_content(&mut Engine::new(selector), path_str, lang, content_str, &[]))
    }

    /// BLAKE3 of `len` bytes at `data`, written as 64 hex chars + NUL into `out65`. 0 on success.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_blake3_hex(data: *const u8, len: usize, out65: *mut u8) -> i32 {
        if out65.is_null() || (data.is_null() && len != 0) {
            return AphrodyStatus::InvalidArg as i32;
        }
        // SAFETY: caller guarantees `data` points to `len` readable bytes.
        let bytes = unsafe { raw_slice(data, len) };
        let hex = hash::blake3_hex(bytes);
        // SAFETY: caller guarantees `out65` has 65 writable bytes.
        unsafe {
            std::ptr::copy_nonoverlapping(hex.as_ptr(), out65, 64);
            *out65.add(64) = 0;
        }
        AphrodyStatus::Ok as i32
    }

    /// BLAKE3 of `slice`, written as 64 hex chars + NUL into `out65`. 0 on success.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_blake3_slice_hex(slice: AphrodySlice, out65: *mut u8) -> i32 {
        core_blake3_hex(slice.ptr, slice.len, out65)
    }

    fn split_includes(s: &str) -> Vec<PathBuf> {
        s.split(['\n', ';'])
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .collect()
    }

    /// Index `root` restricted to `includes` (`;`-separated, may be empty).
    /// `follow_ignore != 0` honours .gitignore. Returns the full `Index` JSON.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_index_json(
        root: *const c_char,
        includes: *const c_char,
        follow_ignore: i32,
    ) -> *mut c_char {
        // SAFETY: caller passes NUL-terminated strings valid for the call.
        let root_str = unsafe { c_str(root) };
        let includes_str = unsafe { c_str(includes) };
        let idx = index::build(
            Path::new(root_str),
            &split_includes(includes_str),
            follow_ignore != 0,
        );
        json_ok(&idx)
    }

    /// Same walk as [`core_index_json`] but streams each file to `cb` on the calling thread
    /// and returns only the `IndexStats` JSON.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_index_each(
        root: *const c_char,
        includes: *const c_char,
        follow_ignore: i32,
        cb: Option<CoreFileCallback>,
    ) -> *mut c_char {
        let Some(cb) = cb else {
            return json_err("null callback");
        };
        // SAFETY: caller passes NUL-terminated strings valid for the call.
        let root_str = unsafe { c_str(root) };
        let includes_str = unsafe { c_str(includes) };
        let idx = index::build(
            Path::new(root_str),
            &split_includes(includes_str),
            follow_ignore != 0,
        );
        for f in &idx.files {
            if let Ok(c) = CString::new(serde_json::to_string(f).unwrap_or_default()) {
                cb(c.as_ptr());
            }
        }
        json_ok(&idx.stats)
    }

    // Keep `cabi` constants referenced for cbindgen export.
    #[allow(dead_code)]
    const _KEEP_ABI_VERSION: u32 = cabi::APHRODY_ABI_VERSION;
}

/// The index pipeline over the same SQLite file as `ay index`: incremental,
/// BLAKE3-addressed, no per-file JSON. Only the tree-sitter and document stages live here (this
/// crate is L2 and cannot link `aphrody-re`); binary and deep stages run in `ay index`.
#[cfg(feature = "pipeline")]
mod pipeline_exports {
    use crate::cabi::{c_str, json_err, json_ok};
    use aphrody_core::pipeline::{Engine, Options, Shared, Store};
    use std::ffi::c_char;
    use std::path::{Path, PathBuf};

    /// Descend into gitignored trees (third_party clones).
    pub const CORE_PIPELINE_ALL: u32 = 1;
    /// Re-run every stage even when size, mtime and hash match.
    pub const CORE_PIPELINE_FORCE: u32 = 2;
    /// Use the fleet Valkey cache when `AY_VALKEY_URL` / `~/.config/ay/valkey.url` is set.
    pub const CORE_PIPELINE_SHARED: u32 = 4;

    /// Index `root` (restricted to `includes`, `;`-separated, may be empty) into the SQLite file `db`.
    /// Returns the `Report` JSON (files seen, changed, touched, removed, cache hits, totals, timings).
    #[unsafe(no_mangle)]
    pub extern "C" fn core_pipeline_run_json(
        root: *const c_char,
        includes: *const c_char,
        db: *const c_char,
        flags: u32,
    ) -> *mut c_char {
        // SAFETY: caller passes NUL-terminated strings valid for the call.
        let (root, includes, db) = unsafe { (c_str(root), c_str(includes), c_str(db)) };
        let mut o = Options::new(root, db);
        o.include = includes.split([';', '\n']).filter(|p| !p.is_empty()).map(PathBuf::from).collect();
        o.all = flags & CORE_PIPELINE_ALL != 0;
        o.force = flags & CORE_PIPELINE_FORCE != 0;
        let mut shared = if flags & CORE_PIPELINE_SHARED != 0 { Shared::from_env() } else { None };
        o.cache_write = shared.is_some();
        match Engine::new().index(&o, shared.as_mut()) {
            Ok(rep) => json_ok(&rep),
            Err(e) => json_err(e),
        }
    }

    /// Symbol search over the SQLite file `db`: exact name when `exact != 0`, else trigram substring.
    /// Returns a JSON array of `{path, name, kind, line, scope, signature}`.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_pipeline_query_json(db: *const c_char, q: *const c_char, limit: u32, exact: i32) -> *mut c_char {
        // SAFETY: caller passes NUL-terminated strings valid for the call.
        let (db, q) = unsafe { (c_str(db), c_str(q)) };
        let hits = Store::open(Path::new(db)).and_then(|s| {
            if exact != 0 { s.lookup(q, limit as usize) } else { s.search(q, limit as usize) }
        });
        match hits {
            Ok(h) => json_ok(&h),
            Err(e) => json_err(e),
        }
    }
}

#[cfg(feature = "core")]
pub use core_exports::*;
#[cfg(feature = "pipeline")]
pub use pipeline_exports::*;
#[cfg(feature = "ai-os")]
pub use ai_os::*;

#[cfg(all(test, feature = "pipeline"))]
mod pipeline_tests {
    use super::*;
    use std::ffi::{CStr, CString};

    fn take(p: *mut std::ffi::c_char) -> String {
        assert!(!p.is_null());
        let s = unsafe { CStr::from_ptr(p) }.to_str().unwrap().to_owned();
        core_free(p);
        s
    }

    #[test]
    fn run_then_query_through_the_c_abi() {
        let root = CString::new(env!("CARGO_MANIFEST_DIR")).unwrap();
        let inc = CString::new("src").unwrap();
        let db = std::env::temp_dir().join(format!("ay-capi-{}.db", std::process::id()));
        let dbc = CString::new(db.to_str().unwrap()).unwrap();
        let rep = take(core_pipeline_run_json(root.as_ptr(), inc.as_ptr(), dbc.as_ptr(), 0));
        assert!(rep.contains("\"changed\":"), "{rep}");
        let again = take(core_pipeline_run_json(root.as_ptr(), inc.as_ptr(), dbc.as_ptr(), 0));
        assert!(again.contains("\"changed\":0"), "second run is a no-op: {again}");
        let q = CString::new("core_pipeline_run_json").unwrap();
        let hits = take(core_pipeline_query_json(dbc.as_ptr(), q.as_ptr(), 5, 1));
        assert!(hits.contains("core_pipeline_run_json"), "{hits}");
        let _ = std::fs::remove_file(db);
    }
}

#[cfg(all(test, feature = "core"))]
mod tests {
    use super::*;
    use std::ffi::{CStr, CString, c_char};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn take(p: *mut c_char) -> String {
        assert!(!p.is_null());
        let s = unsafe { CStr::from_ptr(p) }.to_str().unwrap().to_owned();
        core_free(p);
        s
    }

    #[test]
    fn parse_rust_and_lua() {
        let p = CString::new("src/t.rs").unwrap();
        let c = CString::new("pub struct TestFFI;\n").unwrap();
        assert!(take(core_parse_json(p.as_ptr(), c.as_ptr())).contains("TestFFI"));
        let p = CString::new("script.lua").unwrap();
        let c = CString::new("local function calc() goto done ::done:: return 1 end\n").unwrap();
        assert!(take(core_parse_json(p.as_ptr(), c.as_ptr())).contains("calc"));
    }

    #[test]
    fn facts_json_reports_comments_strings_and_custom_queries() {
        let p = CString::new("src/t.rs").unwrap();
        let c = CString::new("fn f() { let s = \"lit\"; } // note\n").unwrap();
        let out = take(core_facts_json(p.as_ptr(), c.as_ptr(), std::ptr::null()));
        assert!(out.contains("\"n\":\"comment\"") && out.contains("// note") && out.contains("lit"), "{out}");
        let q = CString::new("(function_item name: (identifier) @name)").unwrap();
        let out = take(core_facts_json(p.as_ptr(), c.as_ptr(), q.as_ptr()));
        assert!(out.contains("\"n\":\"name\"") && !out.contains("\"comment\""), "{out}");
        let u = CString::new("x.unknown").unwrap();
        assert!(take(core_facts_json(u.as_ptr(), c.as_ptr(), std::ptr::null())).contains("\"error\""));
    }

    #[test]
    fn unsupported_is_error_json() {
        let p = CString::new("x.unknown").unwrap();
        assert!(take(core_parse_json(p.as_ptr(), c"".as_ptr())).contains("\"error\""));
    }

    #[test]
    fn languages_lists_all() {
        assert_eq!(
            take(core_languages()).split(',').count(),
            aphrody_core::SupportedLanguage::ALL.len()
        );
    }

    #[test]
    fn blake3_matches_core() {
        let mut buf = [0u8; 65];
        assert_eq!(core_blake3_hex(b"abc".as_ptr(), 3, buf.as_mut_ptr()), 0);
        assert_eq!(&buf[..64], aphrody_core::hash::blake3_hex(b"abc").as_bytes());
        assert_eq!(buf[64], 0);
    }

    static SEEN: AtomicUsize = AtomicUsize::new(0);
    extern "C" fn count(_: *const c_char) {
        SEEN.fetch_add(1, Ordering::Relaxed);
    }

    #[test]
    fn index_each_streams_files() {
        let root = CString::new(env!("CARGO_MANIFEST_DIR")).unwrap();
        let inc = CString::new("src").unwrap();
        let stats = take(core_index_each(root.as_ptr(), inc.as_ptr(), 1, Some(count)));
        // Every source file of this crate (it grows: cabi, lib, sys, ai_os, ...), not a fixed count.
        let n = SEEN.load(Ordering::Relaxed);
        assert!(n >= 2, "{stats}");
        assert!(stats.contains(&format!("\"parsed\":{n}")), "{stats}");
    }
}
