//! One stage graph over the monorepo:
//!
//! ```text
//! walk -> stat skip -> read+BLAKE3 -> detect -> { tree-sitter | text | triage | ghidra | llvm } -> SQLite
//!                                        ^ Valkey cache (BLAKE3 -> facts)    ^ Valkey job streams
//! ```
//!
//! Stages implement [`Stage`] and emit [`Facts`]; [`Store`] owns the single SQLite schema;
//! [`Shared`] is the optional fleet cache, queue and event bus.

pub mod detect;
pub mod engine;
pub mod facts;
pub mod resp;
pub mod shared;
pub mod stages;
pub mod store;

pub use detect::{Detected, Detector, Kind};
pub use engine::{Deep, Engine, Options, Report, WorkOptions};
pub use facts::{BinFacts, Facts, FuncFact, IrFacts, Xref};
pub use shared::{Job, Shared};
pub use stages::{FileInfo, Stage};
pub use store::{Store, SymbolHit, Totals};
