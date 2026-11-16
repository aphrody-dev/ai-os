//! Data-driven grammar registry.
//!
//! Reads `third_party/ECOSYSTEM.toml` (any table/array entry with `path` and a `kind` containing
//! "tree-sitter" or "grammar"); when absent, falls back to every `third_party/tree-sitter-*` clone.
//! For each grammar declared in the clone's `tree-sitter.json`, compiles `src/parser.c`
//! (+ `src/scanner.c`) with the C compiler from `CC` (the shared LLVM clang) and emits
//! `OUT_DIR/grammars.rs`: one `Grammar` entry with file types and the embedded `tags.scm`.
//! Exported C symbols are renamed `aphrody_grammar_<name>*` so they never clash with the
//! crates.io grammars linked for the dedicated extractors.
//! Off unless the `grammars` feature (or `APHRODY_GRAMMARS=1`) asks for it: the parser tables are the bulk of
//! the binary (see `main`). Override the manifest with `APHRODY_GRAMMARS_MANIFEST`; `APHRODY_GRAMMARS=0` wins
//! over the feature.

use std::fmt::Write as _;
use std::path::PathBuf;

#[path = "src/registry_build.rs"]
mod registry_build;
use registry_build::{GrammarSrc, grammar_repos, grammars_in};

const SCANNER_FNS: [&str; 5] = [
    "external_scanner_create",
    "external_scanner_destroy",
    "external_scanner_scan",
    "external_scanner_serialize",
    "external_scanner_deserialize",
];

fn main() {
    // SRC_ROOT comes from .cargo/config.toml [env] (absolute repo root).
    let src_root = PathBuf::from(std::env::var("SRC_ROOT").expect("SRC_ROOT (.cargo/config.toml [env])"));
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("grammars.rs");
    println!("cargo:rerun-if-env-changed=APHRODY_GRAMMARS");
    println!("cargo:rerun-if-env-changed=APHRODY_GRAMMARS_MANIFEST");

    let mut code = String::from("pub static GRAMMARS: &[Grammar] = &[\n");
    let mut decls = String::new();
    // Opt in, never by what the checkout happens to hold: every clone of third_party/tree-sitter-* adds its parser
    // tables to the binary (127 clones on fr1: `ay` 204 MB, against 42 MB for the CI checkout that has none, and
    // `strip` removes none of it). The `grammars` feature or APHRODY_GRAMMARS=1 turns the registry on, =0 turns it off.
    let wanted = match std::env::var("APHRODY_GRAMMARS").as_deref() {
        Ok("1") => true,
        Ok("0") => false,
        _ => std::env::var_os("CARGO_FEATURE_GRAMMARS").is_some(),
    };
    if wanted {
        let manifest = std::env::var("APHRODY_GRAMMARS_MANIFEST")
            .map(PathBuf::from)
            .unwrap_or_else(|_| src_root.join("third_party/ECOSYSTEM.toml"));
        println!("cargo:rerun-if-changed={}", manifest.display());
        let mut seen = std::collections::BTreeSet::new();
        for repo in grammar_repos(&src_root, &manifest) {
            for g in grammars_in(&repo) {
                if !seen.insert(g.name.clone()) {
                    continue;
                }
                match compile(&g) {
                    Ok(()) => emit(&g, &mut decls, &mut code),
                    Err(e) => println!("cargo:warning=grammar {} skipped: {e}", g.name),
                }
            }
        }
    }
    code.push_str("];\n");
    let body = format!("unsafe extern \"C\" {{\n{decls}}}\n{code}");
    std::fs::write(out, body).unwrap();
}

fn compile(g: &GrammarSrc) -> Result<(), String> {
    if g.src.join("scanner.cc").is_file() {
        return Err("C++ scanner (scanner.cc) unsupported".into());
    }
    // tree-sitter.json may declare a dialect whose entry point lives in another parser.c.
    let parser = std::fs::read_to_string(g.src.join("parser.c")).map_err(|e| e.to_string())?;
    if !parser.contains(&format!("tree_sitter_{}(", g.ident)) {
        return Err(format!("src/parser.c does not define tree_sitter_{}", g.ident));
    }
    // Runtime tree-sitter 0.27 loads ABI >= 13 (tree_sitter::MIN_COMPATIBLE_LANGUAGE_VERSION).
    let abi = parser
        .lines()
        .find_map(|l| l.strip_prefix("#define LANGUAGE_VERSION "))
        .and_then(|v| v.trim().parse::<u32>().ok())
        .unwrap_or(0);
    if abi < 13 {
        return Err(format!("ABI {abi} < 13, regenerate with `tree-sitter generate`"));
    }
    let mut b = cc::Build::new();
    b.include(&g.src).warnings(false).cargo_warnings(false).file(g.src.join("parser.c"));
    if g.src.join("scanner.c").is_file() {
        b.file(g.src.join("scanner.c"));
    }
    let base = format!("tree_sitter_{}", g.ident);
    b.define(&base, Some(format!("aphrody_grammar_{}", g.ident).as_str()));
    for f in SCANNER_FNS {
        b.define(&format!("{base}_{f}"), Some(format!("aphrody_grammar_{}_{f}", g.ident).as_str()));
    }
    println!("cargo:rerun-if-changed={}", g.src.join("parser.c").display());
    b.try_compile(&format!("aphrody_grammar_{}", g.ident)).map_err(|e| e.to_string())
}

fn emit(g: &GrammarSrc, decls: &mut String, code: &mut String) {
    let _ = writeln!(decls, "    fn aphrody_grammar_{}() -> *const ();", g.ident);
    let tags = match &g.tags {
        Some(p) => format!("Some(include_str!({:?}))", p.display().to_string()),
        None => "None".into(),
    };
    let _ = writeln!(
        code,
        "    Grammar {{ name: {:?}, file_types: &{:?}, raw: aphrody_grammar_{}, tags: {tags} }},",
        g.name, g.file_types, g.ident
    );
}

