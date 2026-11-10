pub mod system1;

use memmap2::MmapOptions;
use rayon::prelude::*;
use safetensors::SafeTensors;
use serde::Serialize;
use std::ffi::{CStr, CString};
use std::fs::File;
use std::os::raw::c_char;
use std::path::Path;
use std::slice;
use zerocopy::{FromBytes, Immutable, IntoBytes, KnownLayout};

#[repr(C)]
#[derive(Copy, Clone, Debug, FromBytes, IntoBytes, Immutable, KnownLayout)]
pub struct ZeroCopyRagHeader {
    pub magic: u32,
    pub version: u32,
    pub num_vectors: u64,
    pub dim: u64,
}

// ============================================================================
// 1. AVX2 + FMA3 Bare-Metal SIMD Cosine & Dot-Product Vector RAG Engine
// ============================================================================

#[inline]
pub fn dot_product_f32(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    #[cfg(all(target_arch = "x86_64", target_feature = "avx2", target_feature = "fma"))]
    unsafe {
        return dot_product_avx2_fma(a.as_ptr(), b.as_ptr(), n);
    }
    #[cfg(not(all(target_arch = "x86_64", target_feature = "avx2", target_feature = "fma")))]
    {
        if is_x86_feature_detected!("avx2") && is_x86_feature_detected!("fma") {
            return unsafe { dot_product_avx2_fma(a.as_ptr(), b.as_ptr(), n) };
        }
        a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2,fma")]
unsafe fn dot_product_avx2_fma(a: *const f32, b: *const f32, n: usize) -> f32 {
    use std::arch::x86_64::*;
    let mut sum0 = _mm256_setzero_ps();
    let mut sum1 = _mm256_setzero_ps();
    let mut i = 0usize;
    while i + 16 <= n {
        let va0 = unsafe { _mm256_loadu_ps(a.add(i)) };
        let vb0 = unsafe { _mm256_loadu_ps(b.add(i)) };
        sum0 = _mm256_fmadd_ps(va0, vb0, sum0);

        let va1 = unsafe { _mm256_loadu_ps(a.add(i + 8)) };
        let vb1 = unsafe { _mm256_loadu_ps(b.add(i + 8)) };
        sum1 = _mm256_fmadd_ps(va1, vb1, sum1);
        i += 16;
    }
    let sum256 = _mm256_add_ps(sum0, sum1);
    let hi128 = _mm256_extractf128_ps(sum256, 1);
    let lo128 = _mm256_castps256_ps128(sum256);
    let sum128 = _mm_add_ps(lo128, hi128);
    let shuf = _mm_movehdup_ps(sum128);
    let sums = _mm_add_ps(sum128, shuf);
    let shuf2 = _mm_movehl_ps(shuf, sums);
    let sums2 = _mm_add_ss(sums, shuf2);
    let mut total = _mm_cvtss_f32(sums2);
    while i < n {
        total += unsafe { *a.add(i) * *b.add(i) };
        i += 1;
    }
    total
}

#[inline]
pub fn cosine_similarity_f32(a: &[f32], b: &[f32]) -> f32 {
    let dot = dot_product_f32(a, b);
    let na = dot_product_f32(a, a);
    let nb = dot_product_f32(b, b);
    let denom = (na * nb).sqrt();
    if denom > 1e-12 { dot / denom } else { 0.0 }
}

pub fn batch_cosine_rag_parallel(query: &[f32], corpus: &[f32], dim: usize, scores_out: &mut [f32]) {
    if dim == 0 || query.len() < dim {
        return;
    }
    let q = &query[..dim];
    let q_norm = dot_product_f32(q, q).sqrt();
    if q_norm <= 1e-12 {
        scores_out.fill(0.0);
        return;
    }
    scores_out
        .par_iter_mut()
        .enumerate()
        .for_each(|(idx, out_val)| {
            let offset = idx * dim;
            if offset + dim <= corpus.len() {
                let doc = &corpus[offset..offset + dim];
                let dot = dot_product_f32(q, doc);
                let d_norm = dot_product_f32(doc, doc).sqrt();
                let denom = q_norm * d_norm;
                *out_val = if denom > 1e-12 { dot / denom } else { 0.0 };
            } else {
                *out_val = 0.0;
            }
        });
}

// Heretic Directional Refusal Abliteration on CPU AVX2 + Rayon
pub fn heretic_abliterate_parallel(
    weights: &mut [f32],
    refusal_dir: &[f32],
    out_features: usize,
    in_features: usize,
    scale: f32,
) {
    if in_features == 0 || refusal_dir.len() < in_features {
        return;
    }
    let r = &refusal_dir[..in_features];
    weights
        .par_chunks_exact_mut(in_features)
        .take(out_features)
        .for_each(|row| {
            let proj = dot_product_f32(row, r) * scale;
            for j in 0..in_features {
                row[j] -= proj * r[j];
            }
        });
}

// ============================================================================
// 2. Zero-Copy Memory-Mapped Safetensors & GGUF Header Inspector
// ============================================================================

#[derive(Serialize)]
pub struct SafetensorSummary {
    pub ok: bool,
    pub path: String,
    pub file_bytes: u64,
    pub tensor_count: usize,
    pub zero_copy_mmap: bool,
    pub tensors: Vec<TensorMeta>,
}

#[derive(Serialize)]
pub struct TensorMeta {
    pub name: String,
    pub dtype: String,
    pub shape: Vec<usize>,
    pub byte_len: usize,
    pub data_ptr_aligned_64b: bool,
}

pub fn inspect_safetensors_zero_copy(path: &Path) -> Result<SafetensorSummary, String> {
    let file = File::open(path).map_err(|e| format!("open failed: {e}"))?;
    let file_bytes = file
        .metadata()
        .map_err(|e| format!("stat failed: {e}"))?
        .len();
    let mmap = unsafe { MmapOptions::new().map(&file) }.map_err(|e| format!("mmap failed: {e}"))?;
    let st = SafeTensors::deserialize(&mmap).map_err(|e| format!("safetensors parse failed: {e}"))?;

    let mut tensors = Vec::new();
    for (name, view) in st.tensors() {
        let ptr_addr = view.data().as_ptr() as usize;
        tensors.push(TensorMeta {
            name,
            dtype: format!("{:?}", view.dtype()),
            shape: view.shape().to_vec(),
            byte_len: view.data().len(),
            data_ptr_aligned_64b: (ptr_addr % 64) == 0,
        });
    }
    tensors.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(SafetensorSummary {
        ok: true,
        path: path.to_string_lossy().replace('\\', "/"),
        file_bytes,
        tensor_count: tensors.len(),
        zero_copy_mmap: true,
        tensors,
    })
}

// ============================================================================
// 3. Tree-Sitter Native AOT Polyglot AST Chunker (Python / Rust / TypeScript)
// ============================================================================

#[derive(Serialize)]
pub struct AstSymbolChunk {
    pub kind: String,
    pub name: String,
    pub start_line: usize,
    pub end_line: usize,
    pub byte_len: usize,
}

#[derive(Serialize)]
pub struct AstParseReport {
    pub ok: bool,
    pub language: String,
    pub root_kind: String,
    pub total_nodes: usize,
    pub has_error: bool,
    pub symbols: Vec<AstSymbolChunk>,
}

fn count_nodes(node: tree_sitter::Node) -> usize {
    let mut total = 1usize;
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        total += count_nodes(child);
    }
    total
}

fn collect_top_symbols(node: tree_sitter::Node, src: &[u8], out: &mut Vec<AstSymbolChunk>) {
    let kind = node.kind();
    let is_symbol = matches!(
        kind,
        "function_definition"
            | "class_definition"
            | "function_item"
            | "struct_item"
            | "enum_item"
            | "impl_item"
            | "trait_item"
            | "function_declaration"
            | "class_declaration"
            | "interface_declaration"
            | "type_alias_declaration"
    );

    if is_symbol {
        let name = node
            .child_by_field_name("name")
            .and_then(|n| n.utf8_text(src).ok())
            .unwrap_or("<anonymous>")
            .to_string();
        out.push(AstSymbolChunk {
            kind: kind.to_string(),
            name,
            start_line: node.start_position().row + 1,
            end_line: node.end_position().row + 1,
            byte_len: node.end_byte().saturating_sub(node.start_byte()),
        });
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_top_symbols(child, src, out);
    }
}

pub fn parse_polyglot_ast(lang: &str, code: &str) -> Result<AstParseReport, String> {
    let mut parser = tree_sitter::Parser::new();
    let norm = lang.trim().to_ascii_lowercase();
    match norm.as_str() {
        "python" | "py" => parser
            .set_language(&tree_sitter_python::LANGUAGE.into())
            .map_err(|e| format!("lang error: {e}"))?,
        "rust" | "rs" => parser
            .set_language(&tree_sitter_rust::LANGUAGE.into())
            .map_err(|e| format!("lang error: {e}"))?,
        "typescript" | "ts" => parser
            .set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())
            .map_err(|e| format!("lang error: {e}"))?,
        "tsx" => parser
            .set_language(&tree_sitter_typescript::LANGUAGE_TSX.into())
            .map_err(|e| format!("lang error: {e}"))?,
        _ => return Err(format!("Unsupported language: {lang}")),
    }

    let tree = parser
        .parse(code, None)
        .ok_or_else(|| "tree-sitter returned None".to_string())?;
    let root = tree.root_node();
    let total_nodes = count_nodes(root);
    let mut symbols = Vec::new();
    collect_top_symbols(root, code.as_bytes(), &mut symbols);

    Ok(AstParseReport {
        ok: true,
        language: norm,
        root_kind: root.kind().to_string(),
        total_nodes,
        has_error: root.has_error(),
        symbols,
    })
}

// ============================================================================
// 4. Zero-Copy C-ABI Exports for Bun (`bun:ffi`), C/C++, and Python (`ctypes`)
// ============================================================================

#[unsafe(no_mangle)]
pub extern "C" fn sov_polyglot_abi_version() -> u32 {
    let hdr = ZeroCopyRagHeader {
        magic: 0x534F5631,
        version: 2,
        num_vectors: 0,
        dim: 0,
    };
    let bytes = hdr.as_bytes();
    ZeroCopyRagHeader::ref_from_bytes(bytes)
        .map(|h| h.version)
        .unwrap_or(2)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sov_polyglot_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        unsafe {
            let _ = CString::from_raw(ptr);
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sov_polyglot_dot_f32(
    a_ptr: *const f32,
    b_ptr: *const f32,
    len: usize,
) -> f32 {
    if a_ptr.is_null() || b_ptr.is_null() || len == 0 {
        return 0.0;
    }
    let a = unsafe { slice::from_raw_parts(a_ptr, len) };
    let b = unsafe { slice::from_raw_parts(b_ptr, len) };
    dot_product_f32(a, b)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sov_polyglot_cosine_rag_batch(
    query_ptr: *const f32,
    corpus_ptr: *const f32,
    scores_out_ptr: *mut f32,
    num_docs: usize,
    dim: usize,
) -> i32 {
    if query_ptr.is_null() || corpus_ptr.is_null() || scores_out_ptr.is_null() || num_docs == 0 || dim == 0 {
        return -1;
    }
    let q = unsafe { slice::from_raw_parts(query_ptr, dim) };
    let c = unsafe { slice::from_raw_parts(corpus_ptr, num_docs * dim) };
    let out = unsafe { slice::from_raw_parts_mut(scores_out_ptr, num_docs) };
    batch_cosine_rag_parallel(q, c, dim, out);
    0
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sov_polyglot_heretic_abliterate(
    weights_ptr: *mut f32,
    refusal_ptr: *const f32,
    out_features: usize,
    in_features: usize,
    scale: f32,
) -> i32 {
    if weights_ptr.is_null() || refusal_ptr.is_null() || out_features == 0 || in_features == 0 {
        return -1;
    }
    let w = unsafe { slice::from_raw_parts_mut(weights_ptr, out_features * in_features) };
    let r = unsafe { slice::from_raw_parts(refusal_ptr, in_features) };
    heretic_abliterate_parallel(w, r, out_features, in_features, scale);
    0
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sov_polyglot_inspect_safetensors(path_cstr: *const c_char) -> *mut c_char {
    if path_cstr.is_null() {
        return std::ptr::null_mut();
    }
    let path_str = match unsafe { CStr::from_ptr(path_cstr).to_str() } {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    let json = match inspect_safetensors_zero_copy(Path::new(path_str)) {
        Ok(rep) => serde_json::to_string(&rep).unwrap_or_else(|_| "{\"ok\":false}".to_string()),
        Err(err) => serde_json::json!({ "ok": false, "error": err }).to_string(),
    };
    CString::new(json)
        .map(|c| c.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sov_polyglot_parse_ast(
    lang_cstr: *const c_char,
    code_cstr: *const c_char,
) -> *mut c_char {
    if lang_cstr.is_null() || code_cstr.is_null() {
        return std::ptr::null_mut();
    }
    let lang = match unsafe { CStr::from_ptr(lang_cstr).to_str() } {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    let code = match unsafe { CStr::from_ptr(code_cstr).to_str() } {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    let json = match parse_polyglot_ast(lang, code) {
        Ok(rep) => serde_json::to_string(&rep).unwrap_or_else(|_| "{\"ok\":false}".to_string()),
        Err(err) => serde_json::json!({ "ok": false, "error": err }).to_string(),
    };
    CString::new(json)
        .map(|c| c.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sov_system1_pack_ternary(
    weights_ptr: *const f32,
    len: usize,
    packed_out_ptr: *mut u8,
) -> f32 {
    if weights_ptr.is_null() || packed_out_ptr.is_null() || len == 0 {
        return 0.0;
    }
    let w = unsafe { slice::from_raw_parts(weights_ptr, len) };
    let (scale, packed) = system1::pack_ternary_row(w);
    let out = unsafe { slice::from_raw_parts_mut(packed_out_ptr, packed.len()) };
    out.copy_from_slice(&packed);
    scale
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sov_system1_bitnet_sparse_gemv(
    packed_weights_ptr: *const u8,
    row_scales_ptr: *const f32,
    active_mask_ptr: *const u8,
    x_ptr: *const f32,
    out_ptr: *mut f32,
    out_features: usize,
    in_features: usize,
) -> usize {
    if packed_weights_ptr.is_null()
        || row_scales_ptr.is_null()
        || active_mask_ptr.is_null()
        || x_ptr.is_null()
        || out_ptr.is_null()
        || out_features == 0
        || in_features == 0
    {
        return 0;
    }
    let row_bytes = (in_features + 3) / 4;
    let pw = unsafe { slice::from_raw_parts(packed_weights_ptr, out_features * row_bytes) };
    let scales = unsafe { slice::from_raw_parts(row_scales_ptr, out_features) };
    let mask = unsafe { slice::from_raw_parts(active_mask_ptr, out_features) };
    let x = unsafe { slice::from_raw_parts(x_ptr, in_features) };
    let out = unsafe { slice::from_raw_parts_mut(out_ptr, out_features) };
    system1::bitnet_powerinfer_gemv(pw, scales, mask, x, out_features, in_features, out)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sov_system1_tune_host_cpu_ssd(path_cstr: *const c_char) -> *mut c_char {
    let opt_path = if path_cstr.is_null() {
        None
    } else {
        unsafe { CStr::from_ptr(path_cstr).to_str().ok() }
            .filter(|s| !s.is_empty())
            .map(Path::new)
    };
    let rep = system1::tune_host_cpu_ssd_ram(opt_path);
    let json = serde_json::to_string(&rep).unwrap_or_else(|_| "{\"ok\":false}".to_string());
    CString::new(json)
        .map(|c| c.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sov_system1_transduce_verbose(raw_cstr: *const c_char) -> *mut c_char {
    if raw_cstr.is_null() {
        return std::ptr::null_mut();
    }
    let raw = match unsafe { CStr::from_ptr(raw_cstr).to_str() } {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    let dec = system1::transduce_verbose_to_system1(raw);
    let json = serde_json::to_string(&dec).unwrap_or_else(|_| "{\"ok\":false}".to_string());
    CString::new(json)
        .map(|c| c.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

// ============================================================================
// 5. PyO3 Native Python Module (`sovereign_polyglot_ffi`)
// ============================================================================

#[cfg(feature = "python-ext")]
mod py_bridge {
    use super::*;
    use pyo3::prelude::*;
    use std::path::PathBuf;

    #[pyfunction]
    fn abi_version() -> u32 {
        sov_polyglot_abi_version()
    }

    #[pyfunction]
    fn cosine_similarity(a: Vec<f32>, b: Vec<f32>) -> f32 {
        cosine_similarity_f32(&a, &b)
    }

    #[pyfunction]
    fn batch_cosine_rag(query: Vec<f32>, corpus: Vec<f32>, dim: usize) -> Vec<f32> {
        if dim == 0 {
            return Vec::new();
        }
        let num_docs = corpus.len() / dim;
        let mut scores = vec![0.0f32; num_docs];
        batch_cosine_rag_parallel(&query, &corpus, dim, &mut scores);
        scores
    }

    #[pyfunction]
    fn heretic_abliterate(
        mut weights: Vec<f32>,
        refusal_dir: Vec<f32>,
        out_features: usize,
        in_features: usize,
        scale: f32,
    ) -> Vec<f32> {
        heretic_abliterate_parallel(&mut weights, &refusal_dir, out_features, in_features, scale);
        weights
    }

    #[pyfunction]
    fn inspect_safetensors_json(path: String) -> PyResult<String> {
        let rep = inspect_safetensors_zero_copy(&PathBuf::from(path))
            .map_err(pyo3::exceptions::PyRuntimeError::new_err)?;
        serde_json::to_string(&rep).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))
    }

    #[pyfunction]
    fn parse_ast_json(lang: String, code: String) -> PyResult<String> {
        let rep = parse_polyglot_ast(&lang, &code)
            .map_err(pyo3::exceptions::PyValueError::new_err)?;
        serde_json::to_string(&rep).map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))
    }

    #[pyfunction]
    fn transduce_verbose_json(raw_output: String) -> PyResult<String> {
        let dec = crate::system1::transduce_verbose_to_system1(&raw_output);
        serde_json::to_string(&dec)
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))
    }

    #[pyfunction]
    fn tune_host_cpu_ssd_json(prefetch_path: Option<String>) -> PyResult<String> {
        let p = prefetch_path.as_deref().map(Path::new);
        let rep = crate::system1::tune_host_cpu_ssd_ram(p);
        serde_json::to_string(&rep)
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))
    }

    #[pymodule]
    pub fn sovereign_polyglot_ffi(m: &Bound<'_, PyModule>) -> PyResult<()> {
        m.add_function(wrap_pyfunction!(abi_version, m)?)?;
        m.add_function(wrap_pyfunction!(cosine_similarity, m)?)?;
        m.add_function(wrap_pyfunction!(batch_cosine_rag, m)?)?;
        m.add_function(wrap_pyfunction!(heretic_abliterate, m)?)?;
        m.add_function(wrap_pyfunction!(inspect_safetensors_json, m)?)?;
        m.add_function(wrap_pyfunction!(parse_ast_json, m)?)?;
        m.add_function(wrap_pyfunction!(transduce_verbose_json, m)?)?;
        m.add_function(wrap_pyfunction!(tune_host_cpu_ssd_json, m)?)?;
        Ok(())
    }
}
