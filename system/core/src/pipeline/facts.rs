//! What a stage emits. One plain data type shared by every stage (tree-sitter, triage, Ghidra,
//! LLVM), so the store has a single `apply` and the cache holds one JSON shape per stage.

use crate::symbols::AstFileSummary;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Facts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ast: Option<AstFileSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bin: Option<BinFacts>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub funcs: Vec<FuncFact>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub xrefs: Vec<Xref>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ir: Option<IrFacts>,
    /// Searchable text (documents) for `text_fts`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BinFacts {
    pub format: String,
    pub arch: Option<String>,
    pub entry: Option<u64>,
    pub sections: u32,
    pub imports: u32,
    pub exports: u32,
    /// Highest section entropy, bits per byte (>= 7.2 reads as packed or encrypted).
    pub entropy: f32,
    pub libraries: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FuncFact {
    pub name: String,
    pub addr: u64,
    pub size: u32,
    pub insns: u32,
    pub blocks: u32,
    /// `native` (decompiled machine code) or `ir` (LLVM function).
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pseudo_c: Option<String>,
}

/// One edge of the binary graph: `call` (function to callee), `import`, `needs` (library), `export`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Xref {
    pub src: String,
    pub dst: String,
    pub kind: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IrFacts {
    pub target: String,
    pub functions: u32,
    pub insns: u64,
    pub simd: u32,
}

impl Facts {
    pub fn is_empty(&self) -> bool {
        self.ast.is_none()
            && self.bin.is_none()
            && self.funcs.is_empty()
            && self.xrefs.is_empty()
            && self.ir.is_none()
            && self.text.is_none()
    }

    /// Fold the output of a later stage into this one (stages write disjoint fields).
    pub fn merge(&mut self, other: Facts) {
        self.ast = other.ast.or(self.ast.take());
        self.bin = other.bin.or(self.bin.take());
        self.ir = other.ir.or(self.ir.take());
        self.text = other.text.or(self.text.take());
        self.funcs.extend(other.funcs);
        self.xrefs.extend(other.xrefs);
    }
}
