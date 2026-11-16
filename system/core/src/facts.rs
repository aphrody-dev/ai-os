//! The one query layer over every grammar: `ay code query`, the C ABI (`core_facts_json`, `core_query_file_json`)
//! and the repository tools (hygiene, docs index, catalog, checkdeps) read the same match stream.
//!
//! A *facts* query is a tree-sitter `.scm` file that lives in `queries/facts/` and uses one capture vocabulary
//! (`@comment`, `@string`, `@import.source`, `@import.name`, `@call` for code; `@heading`, `@paragraph`, ... for
//! Markdown). Languages without a hand-written file get a query derived from their own node kinds
//! ([`derive_query`]), so every grammar of the registry answers `@comment` and `@string` without a table here.
//!
//! JSON shape of one file (short keys, one object per line in `ay code query`):
//! `{"file","lang","error","has_error","matches":[{"p":pattern,"c":[{"n":capture,"l":line,"el":end_line,"s":start_byte,
//! "e":end_byte,"t":text,"k":parent_kind}]}]}`; lines are 1-based, offsets are UTF-8 bytes.

use crate::languages::SupportedLanguage;
use crate::grammars::Grammar;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use streaming_iterator::StreamingIterator;
use tree_sitter::{Language, Parser, Query, QueryCursor};

const ECMASCRIPT: &str = include_str!("../queries/facts/ecmascript.scm");
const TYPESCRIPT: &str = include_str!("../queries/facts/typescript.scm");
const JSX: &str = include_str!("../queries/facts/jsx.scm");
const RUST: &str = include_str!("../queries/facts/rust.scm");
const PYTHON: &str = include_str!("../queries/facts/python.scm");
const BASH: &str = include_str!("../queries/facts/bash.scm");
const C: &str = include_str!("../queries/facts/c.scm");
const CPP: &str = include_str!("../queries/facts/cpp.scm");
const GO: &str = include_str!("../queries/facts/go.scm");
const LUA: &str = include_str!("../queries/facts/lua.scm");
const CSS: &str = include_str!("../queries/facts/css.scm");
const HTML: &str = include_str!("../queries/facts/html.scm");
const JSON: &str = include_str!("../queries/facts/json.scm");
const MARKDOWN: &str = include_str!("../queries/facts/markdown.scm");

/// Node kinds that are string literals in grammars without a facts file.
const STRING_KINDS: &[&str] = &[
    "string",
    "string_literal",
    "raw_string_literal",
    "interpreted_string_literal",
    "verbatim_string_literal",
    "raw_string",
    "template_string",
    "string_lit",
    "str_lit",
];

/// A grammar the facts layer can run: a dedicated one of [`SupportedLanguage`], Markdown, or a registry grammar.
#[derive(Clone, Copy)]
pub enum Lang {
    Core(SupportedLanguage),
    Markdown,
    Registry(&'static Grammar),
}

impl Lang {
    /// Markdown first (the md grammars are not in `SupportedLanguage`), then the dedicated grammars, then the registry.
    pub fn for_path(path: &Path) -> Option<Self> {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown") || ext.eq_ignore_ascii_case("mdx") {
            return Some(Self::Markdown);
        }
        SupportedLanguage::from_path(path)
            .map(Self::Core)
            .or_else(|| Grammar::for_path(path).map(Self::Registry))
    }

    pub fn by_name(name: &str) -> Option<Self> {
        if name == "markdown" {
            return Some(Self::Markdown);
        }
        SupportedLanguage::ALL
            .iter()
            .find(|l| l.name() == name)
            .map(|l| Self::Core(*l))
            .or_else(|| Grammar::by_name(name).map(Self::Registry))
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Core(l) => l.name(),
            Self::Markdown => "markdown",
            Self::Registry(g) => g.name,
        }
    }

    pub fn language(&self) -> Language {
        match self {
            Self::Core(l) => l.tree_sitter_language(),
            Self::Markdown => tree_sitter_md::LANGUAGE.into(),
            Self::Registry(g) => g.language(),
        }
    }

    /// Source of the built-in facts query of this grammar.
    pub fn facts_query(&self) -> String {
        use SupportedLanguage as L;
        match self {
            Self::Markdown => MARKDOWN.to_string(),
            Self::Core(L::JavaScript) => format!("{ECMASCRIPT}\n{JSX}"),
            Self::Core(L::TypeScript) => format!("{ECMASCRIPT}\n{TYPESCRIPT}"),
            Self::Core(L::Tsx) => format!("{ECMASCRIPT}\n{TYPESCRIPT}\n{JSX}"),
            Self::Core(L::Rust) => RUST.to_string(),
            Self::Core(L::Python) => PYTHON.to_string(),
            Self::Core(L::Bash) => BASH.to_string(),
            Self::Core(L::C) => C.to_string(),
            Self::Core(L::Cpp) => CPP.to_string(),
            Self::Core(L::Go) => GO.to_string(),
            Self::Core(L::Lua) => LUA.to_string(),
            Self::Core(L::Css) => CSS.to_string(),
            Self::Core(L::Html) => HTML.to_string(),
            Self::Core(L::Json) => JSON.to_string(),
            Self::Registry(g) => derive_query(&g.language()).unwrap_or_else(|| {
                // A grammar without comment or string kinds still has to compile: match nothing.
                format!("(ERROR) @error\n; no comment or string kind in {}", g.name)
            }),
        }
    }
}

/// Query derived from a grammar's own node kinds: every visible named kind that is a comment (`comment`,
/// `*_comment`) or a string literal. None when the grammar has neither.
pub fn derive_query(lang: &Language) -> Option<String> {
    let mut seen = BTreeSet::new();
    let mut out = String::new();
    for id in 0..lang.node_kind_count() {
        let Ok(id) = u16::try_from(id) else { break };
        if !lang.node_kind_is_named(id) || !lang.node_kind_is_visible(id) {
            continue;
        }
        let Some(kind) = lang.node_kind_for_id(id) else { continue };
        let role = if kind == "comment" || kind.ends_with("_comment") {
            "comment"
        } else if STRING_KINDS.contains(&kind) {
            "string"
        } else {
            continue;
        };
        if seen.insert(kind) {
            let _ = writeln!(out, "({kind}) @{role}");
        }
    }
    (!out.is_empty()).then_some(out)
}

/// Which query an [`Engine`] runs.
#[derive(Clone)]
pub enum Selector {
    /// The built-in facts query of each file's grammar.
    Facts,
    /// A caller's `.scm` source; files whose grammar rejects it report an error instead of aborting the scan.
    Custom(String),
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Capture {
    /// Capture name.
    pub n: String,
    /// 1-based start line.
    pub l: usize,
    /// 1-based end line.
    pub el: usize,
    pub s: usize,
    pub e: usize,
    pub t: String,
    /// Kind of the parent node.
    pub k: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Match {
    /// Pattern index inside the query.
    pub p: usize,
    pub c: Vec<Capture>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct FileMatches {
    pub file: String,
    pub lang: String,
    pub error: Option<String>,
    pub has_error: bool,
    pub matches: Vec<Match>,
}

struct Compiled {
    parser: Parser,
    query: Query,
    /// Hash of everything but the content that shapes the output: query source, grammar ABI, this crate's version.
    salt: String,
}

/// Parsers and compiled queries, one per grammar; keep one per thread (neither is `Sync`).
pub struct Engine {
    selector: Selector,
    cache: HashMap<&'static str, Result<Compiled, String>>,
}

impl Engine {
    pub fn new(selector: Selector) -> Self {
        Self { selector, cache: HashMap::new() }
    }

    fn compiled(&mut self, lang: Lang) -> Result<&mut Compiled, String> {
        let selector = &self.selector;
        let slot = self.cache.entry(lang.name()).or_insert_with(|| {
            let ts = lang.language();
            let mut parser = Parser::new();
            parser.set_language(&ts).map_err(|e| format!("{}: {e}", lang.name()))?;
            let src = match selector {
                Selector::Facts => lang.facts_query(),
                Selector::Custom(q) => q.clone(),
            };
            let query = Query::new(&ts, &src).map_err(|e| format!("{} query: {e}", lang.name()))?;
            let salt = blake3::hash(format!("{src}\0{}\0{}", ts.abi_version(), env!("CARGO_PKG_VERSION")).as_bytes()).to_hex().to_string();
            Ok(Compiled { parser, query, salt })
        });
        slot.as_mut().map_err(|e| e.clone())
    }

    /// Key of the cached result for `content` under this engine's query and capture filter.
    fn cache_key(&mut self, lang: Lang, content: &str, only: &[String]) -> Option<String> {
        let salt = self.compiled(lang).ok()?.salt.clone();
        let mut h = blake3::Hasher::new();
        h.update(salt.as_bytes()).update(&[0]).update(only.join(",").as_bytes()).update(&[0]).update(content.as_bytes());
        Some(h.finalize().to_hex().to_string())
    }

    /// Run the query over `content`; `only` keeps captures named `x` or `x.*` (empty keeps all).
    pub fn run(&mut self, lang: Lang, content: &str, only: &[String]) -> Result<(Vec<Match>, bool), String> {
        let c = self.compiled(lang)?;
        let tree = c.parser.parse(content, None).ok_or("parse cancelled")?;
        let names = c.query.capture_names();
        let bytes = content.as_bytes();
        let keep = |n: &str| {
            !n.starts_with('_') && (only.is_empty() || only.iter().any(|o| n == o || n.strip_prefix(o.as_str()).is_some_and(|r| r.starts_with('.'))))
        };
        let mut cursor = QueryCursor::new();
        let mut it = cursor.matches(&c.query, tree.root_node(), bytes);
        let mut out = Vec::new();
        while let Some(m) = it.next() {
            let caps: Vec<Capture> = m
                .captures()
                .iter()
                .filter_map(|cap| {
                    let n = names[cap.index as usize];
                    keep(n).then(|| Capture {
                        n: n.to_string(),
                        l: cap.node.start_position().row + 1,
                        el: cap.node.end_position().row + 1,
                        s: cap.node.start_byte(),
                        e: cap.node.end_byte(),
                        t: cap.node.utf8_text(bytes).unwrap_or("").to_string(),
                        k: cap.node.parent().map(|p| p.kind().to_string()).unwrap_or_default(),
                    })
                })
                .collect();
            if !caps.is_empty() {
                out.push(Match { p: m.pattern_index, c: caps });
            }
        }
        Ok((out, tree.root_node().has_error()))
    }
}

/// Options of [`scan_files`].
#[derive(Clone)]
pub struct ScanOptions {
    pub selector: Selector,
    pub only: Vec<String>,
    /// Force a grammar by name instead of detecting it from the path.
    pub lang: Option<String>,
    /// Files larger than this are reported as skipped.
    pub max_bytes: u64,
    /// Directory of the result cache: one entry per (content, query, capture filter); an unchanged file is not parsed again.
    pub cache: Option<PathBuf>,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self { selector: Selector::Facts, only: Vec::new(), lang: None, max_bytes: 4_000_000, cache: None }
    }
}

/// Parse and query one file's content; `file` is only the label.
pub fn scan_content(engine: &mut Engine, file: &str, lang: Lang, content: &str, only: &[String]) -> FileMatches {
    let mut out = FileMatches { file: file.to_string(), lang: lang.name().to_string(), ..FileMatches::default() };
    match engine.run(lang, content, only) {
        Ok((matches, has_error)) => {
            out.matches = matches;
            out.has_error = has_error;
        }
        Err(e) => out.error = Some(e),
    }
    out
}

fn scan_one(engine: &mut Engine, path: &Path, opts: &ScanOptions) -> FileMatches {
    let label = path.to_string_lossy().replace('\\', "/");
    let fail = |e: String| FileMatches { file: label.clone(), error: Some(e), ..FileMatches::default() };
    let lang = match &opts.lang {
        Some(n) => Lang::by_name(n),
        None => Lang::for_path(path),
    };
    let Some(lang) = lang else { return fail("no grammar for this path".into()) };
    match std::fs::metadata(path) {
        Ok(m) if m.len() > opts.max_bytes => return fail(format!("skipped: {} bytes", m.len())),
        Err(e) => return fail(e.to_string()),
        Ok(_) => {}
    }
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => return fail(e.to_string()),
    };
    let entry = opts.cache.as_ref().and_then(|dir| {
        let key = engine.cache_key(lang, &content, &opts.only)?;
        Some(dir.join(&key[..2]).join(format!("{key}{CACHE_EXT}")))
    });
    if let Some(hit) = entry.as_deref().and_then(read_cache) {
        return FileMatches { file: label, ..hit };
    }
    let result = scan_content(engine, &label, lang, &content, &opts.only);
    if let (Some(p), None) = (&entry, &result.error) {
        write_cache(p, &result);
    }
    result
}

#[cfg(feature = "cli")]
const CACHE_EXT: &str = ".json.zst";
#[cfg(not(feature = "cli"))]
const CACHE_EXT: &str = ".json";

fn read_cache(p: &Path) -> Option<FileMatches> {
    let raw = std::fs::read(p).ok()?;
    #[cfg(feature = "cli")]
    let raw = zstd::stream::decode_all(raw.as_slice()).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Best effort: a cache that cannot be written only costs the next run a parse.
fn write_cache(p: &Path, r: &FileMatches) {
    let Ok(json) = serde_json::to_vec(r) else { return };
    #[cfg(feature = "cli")]
    let Ok(json) = zstd::stream::encode_all(json.as_slice(), 3) else { return };
    let Some(dir) = p.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let tmp = p.with_extension(format!("tmp{}", std::process::id()));
    if std::fs::write(&tmp, json).is_ok() && std::fs::rename(&tmp, p).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Query every file in parallel (rayon; one parser and compiled query per grammar and worker). Result order
/// follows `files`.
pub fn scan_files(files: &[PathBuf], opts: &ScanOptions) -> Vec<FileMatches> {
    files
        .par_iter()
        .map_init(|| Engine::new(opts.selector.clone()), |engine, p| scan_one(engine, p, opts))
        .collect()
}

/// Files below `roots` (a file is kept as given) that have a grammar, honouring `.gitignore`.
pub fn collect_files(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for r in roots {
        if r.is_file() {
            out.push(r.clone());
            continue;
        }
        let walker = ignore::WalkBuilder::new(r).build();
        out.extend(
            walker
                .flatten()
                .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
                .map(ignore::DirEntry::into_path)
                .filter(|p| Lang::for_path(p).is_some()),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(path: &str, src: &str) -> Vec<Match> {
        let lang = Lang::for_path(Path::new(path)).unwrap_or_else(|| panic!("no grammar for {path}"));
        let (m, _) = Engine::new(Selector::Facts).run(lang, src, &[]).unwrap_or_else(|e| panic!("{path}: {e}"));
        m
    }

    fn texts(m: &[Match], cap: &str) -> Vec<String> {
        m.iter().flat_map(|m| &m.c).filter(|c| c.n == cap).map(|c| c.t.clone()).collect()
    }

    #[test]
    fn ecmascript_imports_strings_comments_calls() {
        let src = "import fs, { a as b, c } from \"node:zlib\";\nimport * as ns from './n';\nexport * from './e';\n\
                   const x = require('node:child_process'); // a comment with \"quotes\"\n\
                   const m = await import('./m');\nconst re = /from \"node:fs\"/;\n\
                   const s = `tpl ${1}`;\ncrypto.createHash('md5'); promisify(f);\n";
        for path in ["a.ts", "a.tsx", "a.js"] {
            let m = facts(path, src);
            let sources = texts(&m, "import.source");
            for want in ["\"node:zlib\"", "'./n'", "'./e'", "'node:child_process'", "'./m'"] {
                assert!(sources.iter().any(|s| s == want), "{path}: {want} in {sources:?}");
            }
            let names = texts(&m, "import.name");
            for want in ["fs", "a", "c", "ns"] {
                assert!(names.iter().any(|n| n == want), "{path}: {want} in {names:?}");
            }
            assert_eq!(texts(&m, "comment"), ["// a comment with \"quotes\""], "{path}");
            // the regex literal is not a string; the comment's quotes are not strings
            let strings = texts(&m, "string");
            assert!(!strings.iter().any(|s| s.contains("node:fs") || s.contains("quotes")), "{path}: {strings:?}");
            assert!(strings.iter().any(|s| s.starts_with('`')), "{path}: template string");
            let calls = texts(&m, "call");
            assert!(calls.iter().any(|c| c == "crypto.createHash") && calls.iter().any(|c| c == "promisify"), "{calls:?}");
        }
    }

    #[test]
    fn jsx_text_is_a_string_in_tsx_and_javascript() {
        for path in ["a.tsx", "a.js"] {
            let m = facts(path, "const a = <p title=\"t\">Bonjour tout le monde</p>;\n");
            let strings = texts(&m, "string");
            assert!(strings.iter().any(|s| s == "Bonjour tout le monde"), "{path}: {strings:?}");
            assert!(strings.iter().any(|s| s == "\"t\""), "{path}: {strings:?}");
        }
    }

    #[test]
    fn typescript_import_require_clause() {
        let m = facts("a.ts", "import g = require('./g');\n");
        assert_eq!(texts(&m, "import.source"), ["'./g'"]);
    }

    #[test]
    fn import_names_share_a_match_with_their_source() {
        let m = facts("a.ts", "import { a, b } from 'x';\n");
        let with_name: Vec<_> = m.iter().filter(|m| m.c.iter().any(|c| c.n == "import.name")).collect();
        assert_eq!(with_name.len(), 2);
        assert!(with_name.iter().all(|m| m.c.iter().any(|c| c.n == "import.source" && c.t == "'x'")));
    }

    #[test]
    fn every_dedicated_grammar_has_a_compiling_facts_query() {
        let samples: &[(&str, &str, &str, &str)] = &[
            ("a.rs", "// c\nfn f() { let s = \"lit\"; g(); }\nuse std::fmt;\n", "// c", "\"lit\""),
            ("a.py", "# c\nimport os\ns = \"lit\"\nprint(s)\n", "# c", "\"lit\""),
            ("a.sh", "# c\necho \"lit\"\n", "# c", "\"lit\""),
            ("a.c", "// c\n#include <stdio.h>\nchar *s = \"lit\";\n", "// c", "\"lit\""),
            ("a.cpp", "// c\n#include \"x.h\"\nconst char *s = \"lit\";\n", "// c", "\"lit\""),
            ("a.go", "package p\n// c\nimport \"fmt\"\nvar s = \"lit\"\n", "// c", "\"lit\""),
            ("a.lua", "-- c\nlocal s = \"lit\"\n", "-- c", "\"lit\""),
            ("a.css", "/* c */\na { content: \"lit\"; }\n", "/* c */", "\"lit\""),
            ("a.html", "<!-- c -->\n<a href=\"lit\">x</a>\n", "<!-- c -->", "lit"),
            ("a.json", "{\"k\": \"lit\"}\n", "", "\"lit\""),
        ];
        for (path, src, comment, string) in samples {
            let m = facts(path, src);
            if !comment.is_empty() {
                assert!(texts(&m, "comment").iter().any(|c| c == comment), "{path}: comments {:?}", texts(&m, "comment"));
            }
            assert!(texts(&m, "string").iter().any(|s| s == string), "{path}: strings {:?}", texts(&m, "string"));
        }
    }

    #[test]
    fn imports_in_other_languages() {
        assert_eq!(texts(&facts("a.rs", "use std::fmt;\n"), "import.source"), ["std::fmt"]);
        assert_eq!(texts(&facts("a.py", "import os\nfrom a.b import c\n"), "import.source"), ["os", "a.b"]);
        assert_eq!(texts(&facts("a.c", "#include <stdio.h>\n"), "import.source"), ["<stdio.h>"]);
        assert_eq!(texts(&facts("a.go", "package p\nimport \"fmt\"\n"), "import.source"), ["\"fmt\""]);
    }

    #[test]
    fn markdown_blocks_carry_their_parent_kind() {
        let src = "---\ntitle: T\n---\n# Head\n\nFirst line.\nsecond.\n\n- item\n\n```rs\nlet a = 1;\n```\n\nSetext\n======\n";
        let m = facts("a.md", src);
        assert_eq!(texts(&m, "frontmatter").len(), 1);
        let heads = texts(&m, "heading");
        assert_eq!(heads.len(), 2, "{heads:?}");
        assert!(heads[0].starts_with("# Head"));
        let paras: Vec<_> = m.iter().flat_map(|m| &m.c).filter(|c| c.n == "paragraph").collect();
        assert_eq!(paras[0].t.trim(), "First line.\nsecond.");
        assert_eq!(paras[0].k, "section");
        assert!(paras.iter().any(|p| p.t.trim() == "item" && p.k == "list_item"), "{paras:?}");
        assert_eq!(texts(&m, "code").len(), 1);
    }

    #[test]
    fn derived_query_covers_comment_and_string_kinds() {
        let q = derive_query(&tree_sitter_rust::LANGUAGE.into()).unwrap();
        for want in ["(line_comment) @comment", "(block_comment) @comment", "(string_literal) @string"] {
            assert!(q.contains(want), "{q}");
        }
        let lang: Language = tree_sitter_rust::LANGUAGE.into();
        Query::new(&lang, &q).unwrap();
        assert!(derive_query(&tree_sitter_json::LANGUAGE.into()).unwrap().contains("(string) @string"));
    }

    #[test]
    fn cache_serves_unchanged_content_and_follows_edits() {
        let dir = std::env::temp_dir().join(format!("aphrody-facts-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (a, cache) = (dir.join("a.rs"), dir.join("cache"));
        std::fs::write(&a, "// one\nfn f() {}\n").unwrap();
        let opts = ScanOptions { cache: Some(cache.clone()), ..ScanOptions::default() };
        let first = scan_files(&[a.clone()], &opts);
        let entries = || ignore::WalkBuilder::new(&cache).build().flatten().filter(|e| e.file_type().is_some_and(|t| t.is_file())).count();
        assert_eq!(entries(), 1);
        let second = scan_files(&[a.clone()], &opts);
        assert_eq!(serde_json::to_string(&first).unwrap(), serde_json::to_string(&second).unwrap());
        assert_eq!(entries(), 1, "a hit writes nothing");
        std::fs::write(&a, "// two\nfn f() {}\n").unwrap();
        let third = scan_files(&[a], &opts);
        assert_eq!(texts(&third[0].matches, "comment"), ["// two"]);
        assert_eq!(entries(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_files_keeps_order_reports_errors_and_filters_captures() {
        let dir = std::env::temp_dir().join(format!("aphrody-facts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let files: Vec<PathBuf> = [("a.ts", "// x\nconst s = 'y';\n"), ("b.txt", "none"), ("c.rs", "fn f() {} // z\n")]
            .iter()
            .map(|(n, c)| {
                std::fs::write(dir.join(n), c).unwrap();
                dir.join(n)
            })
            .collect();
        let opts = ScanOptions { only: vec!["comment".into()], ..ScanOptions::default() };
        let r = scan_files(&files, &opts);
        assert_eq!(r.len(), 3);
        assert!(r[0].file.ends_with("a.ts") && r[2].file.ends_with("c.rs"));
        assert_eq!(texts(&r[0].matches, "comment"), ["// x"]);
        assert!(texts(&r[0].matches, "string").is_empty());
        assert!(r[1].error.is_some());
        assert_eq!(r[2].lang, "rust");
        let custom = ScanOptions { selector: Selector::Custom("(function_item name: (identifier) @n)".into()), ..ScanOptions::default() };
        let r = scan_files(&files, &custom);
        assert_eq!(texts(&r[2].matches, "n"), ["f"]);
        assert!(r[0].error.is_some(), "a query that the grammar rejects is a per-file error");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
