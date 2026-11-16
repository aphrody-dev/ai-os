//! Grammar discovery shared by build.rs (via #[path]) and tests/registry.rs.
//! Pure std + toml + serde_json: no cc, no cargo env.

use std::path::{Path, PathBuf};

pub fn grammar_repos(src_root: &Path, manifest: &Path) -> Vec<PathBuf> {
    if let Ok(text) = std::fs::read_to_string(manifest) {
        let value = match toml::from_str::<toml::Table>(&text).map(toml::Value::Table) {
            Ok(v) => v,
            Err(e) => {
                println!("cargo:warning={} unreadable: {e}", manifest.display());
                return Vec::new();
            }
        };
        let mut repos = Vec::new();
        collect_entries(&value, &mut |path, kind| {
            let k = kind.to_ascii_lowercase();
            if k.contains("tree-sitter") || k.contains("grammar") {
                repos.push(src_root.join(path));
            }
        });
        return repos;
    }
    let mut repos: Vec<PathBuf> = std::fs::read_dir(src_root.join("third_party"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("tree-sitter-")))
        .collect();
    repos.sort();
    repos
}

pub fn collect_entries(v: &toml::Value, f: &mut impl FnMut(&str, &str)) {
    match v {
        toml::Value::Table(t) => {
            if let (Some(p), Some(k)) = (t.get("path").and_then(|x| x.as_str()), t.get("kind").and_then(|x| x.as_str())) {
                f(p, k);
            }
            for child in t.values() {
                collect_entries(child, f);
            }
        }
        toml::Value::Array(a) => a.iter().for_each(|c| collect_entries(c, f)),
        _ => {}
    }
}

pub struct GrammarSrc {
    pub name: String,
    pub ident: String,
    pub src: PathBuf,
    pub file_types: Vec<String>,
    pub tags: Option<PathBuf>,
}

pub fn grammars_in(repo: &Path) -> Vec<GrammarSrc> {
    let meta = repo.join("tree-sitter.json");
    println!("cargo:rerun-if-changed={}", meta.display());
    let Ok(text) = std::fs::read_to_string(&meta) else { return legacy_grammar(repo).into_iter().collect() };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { return Vec::new() };
    let strs = |v: Option<&serde_json::Value>| -> Vec<String> {
        match v {
            Some(serde_json::Value::String(s)) => vec![s.clone()],
            Some(serde_json::Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
            _ => Vec::new(),
        }
    };
    json["grammars"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| {
            let name = g["name"].as_str()?.to_string();
            let dir = repo.join(g["path"].as_str().unwrap_or("."));
            let src = dir.join("src");
            if !ensure_parser(&dir) {
                return None;
            }
            let tags = strs(g.get("tags"))
                .into_iter()
                .map(|t| repo.join(t))
                .chain([dir.join("queries/tags.scm")])
                .find(|p| p.is_file());
            Some(GrammarSrc {
                ident: name.replace(['-', '.'], "_"),
                name,
                src,
                file_types: strs(g.get("file-types")),
                tags,
            })
        })
        .collect()
}

/// Grammars predating `tree-sitter.json` (ABI <= 14 era): name from the directory
/// (`tree-sitter-<name>`), committed `src/parser.c`, file types left empty (match by name).
pub fn legacy_grammar(repo: &Path) -> Option<GrammarSrc> {
    let src = repo.join("src");
    if !ensure_parser(repo) {
        return None;
    }
    let name = repo.file_name()?.to_str()?.strip_prefix("tree-sitter-")?.to_string();
    let tags = Some(repo.join("queries/tags.scm")).filter(|p| p.is_file());
    Some(GrammarSrc { ident: name.replace(['-', '.'], "_"), name, src, file_types: Vec::new(), tags })
}

/// Grammars shipped without a generated `src/parser.c` (e.g. sql, swift) are generated in place
/// with the tree-sitter CLI (`TREE_SITTER_CLI` or `tree-sitter` on PATH) when `grammar.js` exists.
pub fn ensure_parser(dir: &Path) -> bool {
    if dir.join("src/parser.c").is_file() {
        return true;
    }
    if !dir.join("grammar.js").is_file() {
        return false;
    }
    println!("cargo:rerun-if-env-changed=TREE_SITTER_CLI");
    let cli = std::env::var("TREE_SITTER_CLI").unwrap_or_else(|_| "tree-sitter".into());
    match std::process::Command::new(&cli).arg("generate").current_dir(dir).status() {
        Ok(s) if s.success() => dir.join("src/parser.c").is_file(),
        other => {
            println!("cargo:warning={}: `{cli} generate` failed: {other:?}", dir.display());
            false
        }
    }
}
