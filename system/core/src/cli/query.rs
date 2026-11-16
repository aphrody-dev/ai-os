//! `query` and `outline`: the CLI face of `crate::facts` (one engine, parallel scan).

use crate::facts::{Lang, ScanOptions, Selector, collect_files, scan_files};
use crate::{AstSymbol, TreeSitterEngine};
use serde_json::json;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub struct QueryArgs {
    pub paths: Vec<PathBuf>,
    pub file: Option<PathBuf>,
    pub query: Option<String>,
    pub lang: Option<String>,
    pub only: Vec<String>,
    pub max_bytes: u64,
    pub summary: bool,
    pub cache: Option<PathBuf>,
}

/// Paths from the command line; a lone `-` reads a NUL- or newline-separated list from stdin.
fn inputs(paths: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    if paths.len() == 1 && paths[0] == Path::new("-") {
        let mut raw = Vec::new();
        std::io::stdin().read_to_end(&mut raw).map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&raw);
        let sep = if text.contains('\0') { '\0' } else { '\n' };
        return Ok(text.split(sep).map(|s| s.trim_end_matches('\r')).filter(|s| !s.is_empty()).map(PathBuf::from).collect());
    }
    Ok(collect_files(paths))
}

pub fn query(a: QueryArgs) -> Result<i32, String> {
    let selector = match (&a.file, &a.query) {
        (Some(f), _) => Selector::Custom(std::fs::read_to_string(f).map_err(|e| format!("{}: {e}", f.display()))?),
        (None, Some(q)) => Selector::Custom(q.clone()),
        (None, None) => Selector::Facts,
    };
    let files = inputs(&a.paths)?;
    let opts = ScanOptions { selector, only: a.only, lang: a.lang, max_bytes: a.max_bytes, cache: a.cache };
    let results = scan_files(&files, &opts);
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    if a.summary {
        let mut caps: BTreeMap<String, usize> = BTreeMap::new();
        let (mut errors, mut parse_errors) = (0, 0);
        for r in &results {
            errors += usize::from(r.error.is_some());
            parse_errors += usize::from(r.has_error);
            for c in r.matches.iter().flat_map(|m| &m.c) {
                *caps.entry(c.n.clone()).or_default() += 1;
            }
        }
        let line = json!({"files": results.len(), "errors": errors, "parse_errors": parse_errors, "captures": caps});
        writeln!(out, "{line}").map_err(|e| e.to_string())?;
        return Ok(0);
    }
    for r in &results {
        let line = serde_json::to_string(r).map_err(|e| e.to_string())?;
        if writeln!(out, "{line}").is_err() {
            break; // closed pipe: the reader had enough
        }
    }
    Ok(0)
}

pub fn outline(file: &Path, as_json: bool) -> Result<i32, String> {
    let content = std::fs::read_to_string(file).map_err(|e| format!("{}: {e}", file.display()))?;
    if Lang::for_path(file).is_none() {
        return Err(format!("no grammar for {}", file.display()));
    }
    let summary = TreeSitterEngine::parse_file(file, &content).ok_or_else(|| format!("cannot parse {}", file.display()))?;
    let mut syms: Vec<&AstSymbol> = summary.symbols.iter().collect();
    syms.sort_by_key(|s| s.span.start_byte);
    if as_json {
        println!("{}", json!({"file": file.to_string_lossy().replace('\\', "/"), "language": summary.language, "parse_errors": summary.parse_errors, "symbols": syms}));
        return Ok(0);
    }
    for s in syms {
        let scope = s.parent_scope.as_deref().map(|p| format!("{p}::")).unwrap_or_default();
        println!("{:>5}-{:<5} {:<10} {scope}{}", s.span.start_line, s.span.end_line, serde_json::to_value(s.kind).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default(), s.name);
    }
    Ok(0)
}
