//! Grammar registration from third_party/ECOSYSTEM.toml, as performed by build.rs.

#[path = "../src/registry_build.rs"]
#[allow(dead_code)]
mod registry_build;

use registry_build::{grammar_repos, grammars_in};
use std::fs;
use std::path::{Path, PathBuf};

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("aphrody-core-registry-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn grammar(root: &Path, dir: &str, json: Option<&str>, entry: &str) {
    let g = root.join(dir);
    fs::create_dir_all(g.join("src")).unwrap();
    fs::create_dir_all(g.join("queries")).unwrap();
    fs::write(g.join("src/parser.c"), format!("#define LANGUAGE_VERSION 14\nconst void *tree_sitter_{entry}(void) {{ return 0; }}\n")).unwrap();
    fs::write(g.join("queries/tags.scm"), "(identifier) @name").unwrap();
    if let Some(j) = json {
        fs::write(g.join("tree-sitter.json"), j).unwrap();
    }
}

#[test]
fn manifest_kinds_select_grammars_only() {
    let root = scratch("manifest");
    grammar(&root, "third_party/tree-sitter-demo", Some(r#"{"grammars":[{"name":"demo","path":".","file-types":["demo","Demofile"],"tags":["queries/tags.scm"]}]}"#), "demo");
    grammar(&root, "third_party/tree-sitter-old", None, "old");
    fs::create_dir_all(root.join("third_party/llvm-project")).unwrap();
    let manifest = root.join("third_party/ECOSYSTEM.toml");
    fs::write(
        &manifest,
        r#"
[entry.demo]
path = "third_party/tree-sitter-demo"
kind = "grammar"
[entry.old]
path = "third_party/tree-sitter-old"
kind = "grammar"
[entry.llvm]
path = "third_party/llvm-project"
kind = "toolchain"
"#,
    )
    .unwrap();

    let repos = grammar_repos(&root, &manifest);
    assert_eq!(repos.len(), 2, "{repos:?}");
    assert!(repos.iter().all(|r| !r.ends_with("llvm-project")));

    let demo = grammars_in(&root.join("third_party/tree-sitter-demo"));
    assert_eq!(demo.len(), 1);
    assert_eq!(demo[0].name, "demo");
    assert_eq!(demo[0].file_types, ["demo", "Demofile"]);
    assert!(demo[0].tags.as_ref().unwrap().ends_with("tags.scm"));

    // No tree-sitter.json: legacy fallback names the grammar after the directory.
    let old = grammars_in(&root.join("third_party/tree-sitter-old"));
    assert_eq!(old.len(), 1);
    assert_eq!(old[0].name, "old");
    assert!(old[0].file_types.is_empty());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn missing_manifest_falls_back_to_tree_sitter_clones() {
    let root = scratch("fallback");
    grammar(&root, "third_party/tree-sitter-alpha", None, "alpha");
    fs::create_dir_all(root.join("third_party/not-a-grammar")).unwrap();
    let repos = grammar_repos(&root, &root.join("third_party/ECOSYSTEM.toml"));
    assert_eq!(repos, [root.join("third_party/tree-sitter-alpha")]);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn real_manifest_parses_when_present() {
    let src = Path::new(env!("SRC_ROOT"));
    let manifest = src.join("third_party/ECOSYSTEM.toml");
    if manifest.is_file() {
        assert!(!grammar_repos(&src, &manifest).is_empty());
    }
}
