//! Stage 0, detect: what is this file? Extension and magic bytes answer for nearly every file in
//! microseconds; a [`Detector`] (Magika in `aphrody-re`) is consulted only for files they cannot place.

use crate::TreeSitterEngine;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Source,
    Binary,
    Ir,
    Text,
    Other,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Source => "source",
            Self::Binary => "binary",
            Self::Ir => "ir",
            Self::Text => "text",
            Self::Other => "other",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "source" => Self::Source,
            "binary" => Self::Binary,
            "ir" => Self::Ir,
            "text" => Self::Text,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Detected {
    pub kind: Kind,
    /// `rust`, `typescript`, ... for source; `pe`, `elf`, `macho`, `wasm`, `bitcode`, `archive`,
    /// `object` for binaries; `llvm-ir`; `markdown`, `text`; the Magika label otherwise.
    pub label: String,
    pub mime: Option<String>,
    pub score: Option<f32>,
}

impl Detected {
    pub fn new(kind: Kind, label: &str) -> Self {
        Self { kind, label: label.to_string(), mime: None, score: None }
    }
}

/// A content classifier for files that extension and magic bytes cannot place.
pub trait Detector: Send + Sync {
    fn name(&self) -> &'static str;
    /// Thread-safe: called from the parallel read phase.
    fn detect(&self, path: &Path, bytes: &[u8]) -> Option<Detected>;
}

const BINARY_EXT: &[(&str, &str)] = &[
    ("exe", "pe"), ("dll", "pe"), ("sys", "pe"), ("efi", "pe"), ("ocx", "pe"), ("scr", "pe"), ("cpl", "pe"), ("drv", "pe"),
    ("so", "elf"), ("ko", "elf"), ("dylib", "macho"), ("bundle", "macho"), ("o", "object"), ("obj", "object"),
    ("a", "archive"), ("lib", "archive"), ("wasm", "wasm"), ("bc", "bitcode"), ("node", "elf"),
];

const TEXT_EXT: &[(&str, &str)] =
    &[("md", "markdown"), ("mdx", "markdown"), ("markdown", "markdown"), ("txt", "text"), ("rst", "text"), ("adoc", "text")];

/// Placement by name only (no I/O): source grammar, binary extension, `.ll`, document.
pub fn by_name(path: &Path) -> Option<Detected> {
    if let Some(lang) = TreeSitterEngine::language_name(path) {
        return Some(Detected::new(Kind::Source, lang));
    }
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if ext == "ll" {
        return Some(Detected::new(Kind::Ir, "llvm-ir"));
    }
    if let Some((_, l)) = BINARY_EXT.iter().find(|(e, _)| *e == ext) {
        return Some(Detected::new(Kind::Binary, l));
    }
    TEXT_EXT.iter().find(|(e, _)| *e == ext).map(|(_, l)| Detected::new(Kind::Text, l))
}

/// Placement by magic bytes of the first block.
pub fn by_magic(head: &[u8]) -> Option<Detected> {
    let label = match head {
        [b'M', b'Z', ..] if head.len() >= 64 => "pe",
        [0x7f, b'E', b'L', b'F', ..] => "elf",
        [0xfe, 0xed, 0xfa, 0xce | 0xcf, ..] | [0xce | 0xcf, 0xfa, 0xed, 0xfe, ..] => "macho",
        // Fat Mach-O: big-endian arch count below 20; Java class files carry a major version >= 45 there.
        [0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, n, ..] if (1..20).contains(n) => "macho",
        [0, b'a', b's', b'm', ..] => "wasm",
        [b'B', b'C', 0xc0, 0xde, ..] => "bitcode",
        [b'!', b'<', b'a', b'r', b'c', b'h', b'>', b'\n', ..] => "archive",
        _ => return None,
    };
    Some(Detected::new(Kind::Binary, label))
}

/// Name first, magic second (a `.dll` that is really ELF is reported as ELF), then `detectors`.
pub fn detect(path: &Path, head: &[u8], detectors: &[std::sync::Arc<dyn Detector>]) -> Detected {
    let named = by_name(path);
    match named {
        Some(d) if d.kind == Kind::Binary => by_magic(head).unwrap_or(d),
        Some(d) => d,
        None => by_magic(head)
            .or_else(|| detectors.iter().find_map(|d| d.detect(path, head)))
            .unwrap_or_else(|| Detected::new(Kind::Other, if head.is_empty() { "empty" } else { "unknown" })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_magic() {
        assert_eq!(by_name(Path::new("a/b.rs")).unwrap().label, "rust");
        assert_eq!(by_name(Path::new("a/b.DLL")).unwrap().kind, Kind::Binary);
        assert_eq!(by_name(Path::new("m.ll")).unwrap().kind, Kind::Ir);
        assert_eq!(by_name(Path::new("README.md")).unwrap().label, "markdown");
        assert!(by_name(Path::new("LICENSE")).is_none());
        assert_eq!(by_magic(b"\x7fELF\x02\x01").unwrap().label, "elf");
        assert_eq!(by_magic(b"BC\xc0\xde\x35").unwrap().label, "bitcode");
        assert_eq!(by_magic(b"\0asm\x01\0\0\0").unwrap().label, "wasm");
        assert!(by_magic(b"hello").is_none());
        // Extension says PE, bytes say ELF: bytes win.
        assert_eq!(detect(Path::new("x.dll"), b"\x7fELF\x02", &[]).label, "elf");
        assert_eq!(detect(Path::new("blob"), b"", &[]).label, "empty");
    }
}
