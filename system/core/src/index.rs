//! Recursive tree-sitter indexer: walks roots (gitignore-aware), parses every supported
//! file in parallel, hashes it and classifies it by language / layer / feature.

use crate::{AstFileSummary, TreeSitterEngine, hash};
use rayon::prelude::*;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Files above this size are generated/vendored blobs; they are hashed but not parsed.
pub const MAX_PARSE_BYTES: u64 = 1 << 20;

#[derive(Debug, Clone, Serialize)]
pub struct IndexedFile {
    pub path: String,
    pub language: String,
    /// Top-level directory: crates, packages, apps, infra, third_party, vendor, docs...
    pub layer: String,
    /// Second path component (crate/package/clone name).
    pub feature: String,
    pub hash: String,
    pub summary: Option<AstFileSummary>,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct IndexStats {
    pub files: usize,
    pub parsed: usize,
    pub symbols: usize,
    pub calls: usize,
    pub imports: usize,
    pub lines: usize,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
pub struct Index {
    pub root: String,
    pub files: Vec<IndexedFile>,
    pub stats: IndexStats,
}

pub fn classify(rel: &str) -> (String, String) {
    let mut parts = rel.split('/');
    let first = parts.next().unwrap_or("");
    match parts.next() {
        Some(second) => (first.to_string(), second.to_string()),
        None => ("root".to_string(), first.to_string()),
    }
}

/// Index `root`, optionally restricted to `include` sub-paths (relative to root).
/// `follow_ignore = false` also descends into gitignored dirs (third_party clones).
pub fn build(root: &Path, include: &[PathBuf], follow_ignore: bool) -> Index {
    let started = Instant::now();
    let roots: Vec<PathBuf> = if include.is_empty() {
        vec![root.to_path_buf()]
    } else {
        include.iter().map(|p| root.join(p)).collect()
    };
    let mut paths = Vec::new();
    for r in &roots {
        let walker = ignore::WalkBuilder::new(r)
            .git_ignore(follow_ignore)
            .git_exclude(follow_ignore)
            .hidden(true)
            .filter_entry(|e| {
                !matches!(
                    e.file_name().to_str(),
                    Some("node_modules" | "target" | ".git" | "out" | "graphify-out")
                )
            })
            .build();
        for entry in walker.flatten() {
            let p = entry.path();
            if entry.file_type().is_some_and(|t| t.is_file())
                && TreeSitterEngine::is_indexable(p)
            {
                paths.push(p.to_path_buf());
            }
        }
    }
    let mut files: Vec<IndexedFile> = paths
        .par_iter()
        .filter_map(|p| index_file(root, p))
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let mut stats = IndexStats { files: files.len(), ..Default::default() };
    for f in &files {
        if let Some(s) = &f.summary {
            stats.parsed += 1;
            stats.symbols += s.symbols.len();
            stats.calls += s.calls.len();
            stats.imports += s.imports.len();
            stats.lines += s.line_count;
        }
    }
    stats.elapsed_ms = started.elapsed().as_millis();
    Index { root: root.to_string_lossy().replace('\\', "/"), files, stats }
}

fn index_file(root: &Path, p: &Path) -> Option<IndexedFile> {
    let language = TreeSitterEngine::language_name(p)?;
    let rel = p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/");
    let bytes = std::fs::read(p).ok()?;
    let hash = hash::blake3_hex(&bytes);
    let summary = if (bytes.len() as u64) <= MAX_PARSE_BYTES {
        std::str::from_utf8(&bytes)
            .ok()
            .and_then(|text| TreeSitterEngine::parse_file(Path::new(&rel), text))
    } else {
        None
    };
    let (layer, feature) = classify(&rel);
    Some(IndexedFile { path: rel, language: language.to_string(), layer, feature, hash, summary })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_layers() {
        assert_eq!(classify("system/core/src/lib.rs"), ("src".into(), "core".into()));
        assert_eq!(classify("justfile.rs"), ("root".into(), "justfile.rs".into()));
    }

    #[test]
    fn indexes_own_sources() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let idx = build(root, &[PathBuf::from("src")], true);
        assert!(idx.stats.parsed >= 7, "{:?}", idx.stats);
        let lib = idx.files.iter().find(|f| f.path == "src/lib.rs").unwrap();
        assert_eq!(lib.language, "rust");
        assert_eq!(lib.hash.len(), 64);
        assert!(lib.summary.as_ref().unwrap().symbols.iter().any(|s| s.name == "TreeSitterEngine"));
    }
}
