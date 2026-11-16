//! `aphrody_native` PyO3 (ABI3 Python >= 3.10) native core module.
//! Exposes `aphrody-core` (Tree-sitter AST parsing/querying/indexing, BLAKE3) and
//! `aphrody-re` (binary triage, x86-64 disassembly, Ghidra P-Code/Pseudo-C, MinGW-REA,
//! `.pdata` inspection, and Lua 5.2 bytecode audit/transcoding) directly to Python.

use std::path::Path;

use aphrody_core::{SupportedLanguage, TreeSitterEngine, hash, index};
use aphrody_re::{
    ReEngine, SreAnalyzeOptions, analyze_binary_bytes, analyze_pe_mingw_rea, audit_lua52_bytecode,
    disassemble_x64, is_lua52_bytecode, pdata, transcode_lua52_bytecode, triage_bounded,
};
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;

fn py_err(e: impl std::fmt::Display) -> PyErr {
    PyRuntimeError::new_err(e.to_string())
}

#[pyfunction]
fn abi_version() -> u32 {
    1
}

#[pyfunction]
fn languages() -> String {
    SupportedLanguage::ALL
        .iter()
        .map(SupportedLanguage::name)
        .collect::<Vec<_>>()
        .join(",")
}

#[pyfunction]
fn parse_json(path: &str, content: &str) -> PyResult<String> {
    let summary = TreeSitterEngine::parse_file(Path::new(path), content)
        .ok_or_else(|| py_err(format!("unsupported language or parse failure: {path}")))?;
    serde_json::to_string(&summary).map_err(py_err)
}

#[pyfunction]
fn query_json(path: &str, content: &str, query: &str) -> PyResult<String> {
    let lang = TreeSitterEngine::detect_language(Path::new(path))
        .ok_or_else(|| py_err(format!("unsupported language: {path}")))?;
    let matches = TreeSitterEngine::query_sexpr(lang, content, query).map_err(py_err)?;
    serde_json::to_string(&matches).map_err(py_err)
}

#[pyfunction]
fn blake3_hex(data: &[u8]) -> String {
    hash::blake3_hex(data)
}

#[pyfunction]
#[pyo3(signature = (root, includes="", follow_ignore=true))]
fn index_json(root: &str, includes: &str, follow_ignore: bool) -> PyResult<String> {
    let inc: Vec<_> = includes
        .split(['\n', ';'])
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .collect();
    let idx = index::build(Path::new(root), &inc, follow_ignore);
    serde_json::to_string(&idx).map_err(py_err)
}

#[pyfunction]
#[pyo3(signature = (data, strings_limit=64))]
fn re_triage_json(data: &[u8], strings_limit: usize) -> PyResult<String> {
    let rep = triage_bounded(data, strings_limit).map_err(py_err)?;
    serde_json::to_string(&rep).map_err(py_err)
}

#[pyfunction]
fn re_audit_bytes_json(label: &str, data: &[u8]) -> PyResult<String> {
    let rep = ReEngine::audit_bytes(data, label).map_err(py_err)?;
    serde_json::to_string(&rep).map_err(py_err)
}

#[pyfunction]
#[pyo3(signature = (data, rip=0, limit=64))]
fn re_disasm_json(data: &[u8], rip: u64, limit: usize) -> PyResult<String> {
    let insns = disassemble_x64(data, rip, limit);
    serde_json::to_string(&insns).map_err(py_err)
}

#[pyfunction]
#[pyo3(signature = (data, max_roots=4096))]
fn re_pdata_json(data: &[u8], max_roots: u32) -> PyResult<String> {
    pdata::inspect_json(data, max_roots).map_err(py_err)
}

#[pyfunction]
#[pyo3(signature = (data, max_functions=32))]
fn re_ghidra_decompile_bytes_json(data: &[u8], max_functions: usize) -> PyResult<String> {
    let opts = SreAnalyzeOptions {
        max_functions: max_functions.max(1),
        ..SreAnalyzeOptions::default()
    };
    let rep = analyze_binary_bytes("memory.bin", data, &opts).map_err(py_err)?;
    serde_json::to_string(&rep).map_err(py_err)
}

#[pyfunction]
fn re_mingw_audit_json(path: &str, max_functions: usize) -> PyResult<String> {
    let rep = analyze_pe_mingw_rea(Path::new(path), max_functions.max(16)).map_err(py_err)?;
    serde_json::to_string(&rep).map_err(py_err)
}

#[pyfunction]
fn re_lua52_audit_json(data: &[u8]) -> PyResult<String> {
    if !is_lua52_bytecode(data) {
        return Err(py_err("input is not Lua 5.2 bytecode"));
    }
    let rep = audit_lua52_bytecode(data).map_err(py_err)?;
    serde_json::to_string(&rep).map_err(py_err)
}

#[pyfunction]
#[pyo3(signature = (data, target_int=4, target_sizet=4))]
fn re_lua52_transcode(data: &[u8], target_int: u8, target_sizet: u8) -> PyResult<Vec<u8>> {
    transcode_lua52_bytecode(data, target_int, target_sizet).map_err(py_err)
}

#[pymodule]
fn aphrody_native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    m.add_function(wrap_pyfunction!(abi_version, m)?)?;
    m.add_function(wrap_pyfunction!(languages, m)?)?;
    m.add_function(wrap_pyfunction!(parse_json, m)?)?;
    m.add_function(wrap_pyfunction!(query_json, m)?)?;
    m.add_function(wrap_pyfunction!(blake3_hex, m)?)?;
    m.add_function(wrap_pyfunction!(index_json, m)?)?;
    m.add_function(wrap_pyfunction!(re_triage_json, m)?)?;
    m.add_function(wrap_pyfunction!(re_audit_bytes_json, m)?)?;
    m.add_function(wrap_pyfunction!(re_disasm_json, m)?)?;
    m.add_function(wrap_pyfunction!(re_pdata_json, m)?)?;
    m.add_function(wrap_pyfunction!(re_ghidra_decompile_bytes_json, m)?)?;
    m.add_function(wrap_pyfunction!(re_mingw_audit_json, m)?)?;
    m.add_function(wrap_pyfunction!(re_lua52_audit_json, m)?)?;
    m.add_function(wrap_pyfunction!(re_lua52_transcode, m)?)?;
    Ok(())
}
