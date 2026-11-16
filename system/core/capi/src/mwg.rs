//! Dynamic FFI bridge from Rust (`aphrody-core-capi`) to the `mwg` Pure-C23 LLVM core (`mwg_capi.dll` / `libmwg_capi.so`).
//!
//! Contract mirrored by `system/core/capi/include/aphrody_mwg.h`, `system/core/capi/c/mwg_core.c`,
//! and `system/wck/src/mwg-ffi.ts`.

use std::ffi::{CStr, CString, c_char, c_void};
use std::path::Path;

pub const MWG_ABI_VERSION: u32 = 1;

type FnAbiVersion = unsafe extern "C" fn() -> u32;
type FnFree = unsafe extern "C" fn(*mut c_char);
type FnAuditJson = unsafe extern "C" fn(*const c_char) -> *mut c_char;
type FnSearchJson = unsafe extern "C" fn(*const c_char, *const c_char, u32) -> *mut c_char;
type FnHash64 = unsafe extern "C" fn(*const u8, usize) -> u64;

#[cfg(windows)]
unsafe extern "system" {
    fn LoadLibraryA(name: *const c_char) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const c_char) -> *mut c_void;
    fn FreeLibrary(module: *mut c_void) -> i32;
}

#[cfg(unix)]
unsafe extern "C" {
    fn dlopen(filename: *const c_char, flags: i32) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn dlclose(handle: *mut c_void) -> i32;
}

pub struct MwgCore {
    handle: *mut c_void,
    abi_version: FnAbiVersion,
    free_fn: FnFree,
    audit_html_json_fn: FnAuditJson,
    audit_css_json_fn: FnAuditJson,
    audit_js_json_fn: FnAuditJson,
    parse_mdx_json_fn: FnAuditJson,
    search_guidance_json_fn: FnSearchJson,
    feature_lookup_json_fn: FnAuditJson,
    hash64_fn: FnHash64,
}

unsafe impl Send for MwgCore {}
unsafe impl Sync for MwgCore {}

impl Drop for MwgCore {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            #[cfg(windows)]
            unsafe {
                FreeLibrary(self.handle);
            }
            #[cfg(unix)]
            unsafe {
                dlclose(self.handle);
            }
        }
    }
}

unsafe fn load_sym<T>(handle: *mut c_void, name: &str) -> Result<T, String> {
    let cname = CString::new(name).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let ptr = unsafe { GetProcAddress(handle, cname.as_ptr()) };
    #[cfg(unix)]
    let ptr = unsafe { dlsym(handle, cname.as_ptr()) };
    if ptr.is_null() {
        return Err(format!("missing symbol in mwg_capi: {name}"));
    }
    Ok(unsafe { std::mem::transmute_copy(&ptr) })
}

impl MwgCore {
    /// Load `mwg_capi` from an explicit path (e.g. `system/wck/native/mwg_capi.dll`).
    pub fn load(path: impl AsRef<Path>) -> Result<Self, String> {
        let p = path.as_ref().to_string_lossy();
        let cpath = CString::new(p.as_ref()).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        let handle = unsafe { LoadLibraryA(cpath.as_ptr()) };
        #[cfg(unix)]
        let handle = unsafe { dlopen(cpath.as_ptr(), 2 /* RTLD_NOW */) };
        if handle.is_null() {
            return Err(format!("failed to load mwg_capi at {}", p));
        }

        let core = unsafe {
            Self {
                handle,
                abi_version: load_sym(handle, "mwg_abi_version")?,
                free_fn: load_sym(handle, "mwg_free")?,
                audit_html_json_fn: load_sym(handle, "mwg_audit_html_json")?,
                audit_css_json_fn: load_sym(handle, "mwg_audit_css_json")?,
                audit_js_json_fn: load_sym(handle, "mwg_audit_js_json")?,
                parse_mdx_json_fn: load_sym(handle, "mwg_parse_mdx_json")?,
                search_guidance_json_fn: load_sym(handle, "mwg_search_guidance_json")?,
                feature_lookup_json_fn: load_sym(handle, "mwg_feature_lookup_json")?,
                hash64_fn: load_sym(handle, "mwg_hash64")?,
            }
        };

        let abi = unsafe { (core.abi_version)() };
        if abi != MWG_ABI_VERSION {
            return Err(format!(
                "mwg_capi ABI mismatch: expected {MWG_ABI_VERSION}, got {abi}"
            ));
        }
        Ok(core)
    }

    fn take_json(&self, ptr: *mut c_char) -> Result<String, String> {
        if ptr.is_null() {
            return Err("mwg_capi returned null pointer".into());
        }
        let s = unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
        unsafe { (self.free_fn)(ptr) };
        Ok(s)
    }

    pub fn audit_html_json(&self, html: &str) -> Result<String, String> {
        let c = CString::new(html).map_err(|e| e.to_string())?;
        self.take_json(unsafe { (self.audit_html_json_fn)(c.as_ptr()) })
    }

    pub fn audit_css_json(&self, css: &str) -> Result<String, String> {
        let c = CString::new(css).map_err(|e| e.to_string())?;
        self.take_json(unsafe { (self.audit_css_json_fn)(c.as_ptr()) })
    }

    pub fn audit_js_json(&self, js: &str) -> Result<String, String> {
        let c = CString::new(js).map_err(|e| e.to_string())?;
        self.take_json(unsafe { (self.audit_js_json_fn)(c.as_ptr()) })
    }

    pub fn parse_mdx_json(&self, mdx: &str) -> Result<String, String> {
        let c = CString::new(mdx).map_err(|e| e.to_string())?;
        self.take_json(unsafe { (self.parse_mdx_json_fn)(c.as_ptr()) })
    }

    pub fn search_guidance_json(
        &self,
        query: &str,
        corpus_json: &str,
        top_k: u32,
    ) -> Result<String, String> {
        let cq = CString::new(query).map_err(|e| e.to_string())?;
        let cc = CString::new(corpus_json).map_err(|e| e.to_string())?;
        self.take_json(unsafe {
            (self.search_guidance_json_fn)(cq.as_ptr(), cc.as_ptr(), top_k)
        })
    }

    pub fn feature_lookup_json(&self, feature_id: &str) -> Result<String, String> {
        let c = CString::new(feature_id).map_err(|e| e.to_string())?;
        self.take_json(unsafe { (self.feature_lookup_json_fn)(c.as_ptr()) })
    }

    pub fn hash64(&self, data: &[u8]) -> u64 {
        unsafe { (self.hash64_fn)(data.as_ptr(), data.len()) }
    }
}
