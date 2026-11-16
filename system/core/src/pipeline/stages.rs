//! The stage trait and the two built-in stages (tree-sitter parse, document text). Binary triage,
//! Ghidra and LLVM stages implement the same trait in `aphrody-re` and `ay`.

use super::detect::{Detected, Kind};
use super::facts::Facts;
use crate::{TreeSitterEngine, index::MAX_PARSE_BYTES};
use std::path::Path;

/// What a stage knows about the file it runs on.
pub struct FileInfo<'a> {
    /// Path relative to the index root, forward slashes.
    pub path: &'a str,
    pub abs: &'a Path,
    pub size: u64,
    /// BLAKE3 hex of the content: the cache key.
    pub hash: &'a str,
    pub det: &'a Detected,
}

/// One node of the graph. A stage is a pure function of the file content: the same
/// (name, version, hash) always yields the same [`Facts`], so results are cached by that triple.
pub trait Stage: Send + Sync {
    fn name(&self) -> &'static str;
    /// Bump when the output or its meaning changes; part of every cache key.
    fn version(&self) -> u32;
    fn accepts(&self, f: &FileInfo<'_>) -> bool;
    /// Heavy stages (Ghidra, LLVM) go through the job queue to worker hosts unless run inline.
    fn heavy(&self) -> bool {
        false
    }
    fn run(&self, f: &FileInfo<'_>, bytes: &[u8]) -> Result<Facts, String>;
}

pub struct TreeSitterStage;

impl Stage for TreeSitterStage {
    fn name(&self) -> &'static str {
        "tree-sitter"
    }

    fn version(&self) -> u32 {
        1
    }

    fn accepts(&self, f: &FileInfo<'_>) -> bool {
        f.det.kind == Kind::Source && f.size <= MAX_PARSE_BYTES
    }

    fn run(&self, f: &FileInfo<'_>, bytes: &[u8]) -> Result<Facts, String> {
        let text = std::str::from_utf8(bytes).map_err(|_| "not utf-8".to_string())?;
        let ast = TreeSitterEngine::parse_file(Path::new(f.path), text).ok_or("no grammar")?;
        Ok(Facts { ast: Some(ast), ..Facts::default() })
    }
}

/// Documents (markdown, text) into `text_fts`.
pub struct TextStage;

pub const MAX_TEXT: u64 = 256 << 10;

impl Stage for TextStage {
    fn name(&self) -> &'static str {
        "text"
    }

    fn version(&self) -> u32 {
        1
    }

    fn accepts(&self, f: &FileInfo<'_>) -> bool {
        f.det.kind == Kind::Text && f.size <= MAX_TEXT
    }

    fn run(&self, _f: &FileInfo<'_>, bytes: &[u8]) -> Result<Facts, String> {
        Ok(Facts { text: Some(String::from_utf8_lossy(bytes).into_owned()), ..Facts::default() })
    }
}
