//! Command line of the facts layer, shared by the `aphrody-code` binary and by `ay code` (which embeds [`Cmd`]):
//! `query` runs tree-sitter queries over files in parallel, `outline` lists definitions, `grammars` lists the registry
//! and `--sync` compares it with the upstream grammar orgs. Feature `cli`.

mod grammars;
mod query;

use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser, Debug, PartialEq)]
#[command(name = "aphrody-code", about = "tree-sitter facts, outlines and the grammar registry")]
pub struct Cli {
    #[command(subcommand)]
    pub cmd: Cmd,
}

#[derive(Subcommand, Debug, PartialEq)]
pub enum Cmd {
    /// Run a tree-sitter query over files or directories in parallel; one JSON object per file (built-in facts
    /// query: comments, strings, imports, calls, Markdown blocks; or --file/--query). `-` reads paths from stdin
    Query {
        paths: Vec<PathBuf>,
        /// A .scm file with the query
        #[arg(long)]
        file: Option<PathBuf>,
        /// An inline S-expression query
        #[arg(long)]
        query: Option<String>,
        /// Grammar name instead of detecting it from the path
        #[arg(long)]
        lang: Option<String>,
        /// Keep only these captures (`x` also keeps `x.*`)
        #[arg(long, value_delimiter = ',')]
        only: Vec<String>,
        #[arg(long, default_value_t = 4_000_000)]
        max_bytes: u64,
        /// Print capture counts only
        #[arg(long)]
        summary: bool,
        /// Result cache directory: an unchanged file (same content, query and captures) is not parsed again
        #[arg(long)]
        cache: Option<PathBuf>,
    },
    /// List the definitions of one file (kind, lines, name)
    Outline {
        file: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// List the grammar registry; --sync compares it with the upstream tree-sitter and tree-sitter-grammars orgs
    Grammars {
        #[arg(long)]
        sync: bool,
        /// With --sync: append the missing grammars to the manifest as candidates
        #[arg(long)]
        write: bool,
        #[arg(long)]
        json: bool,
        /// Manifest read by system/core/build.rs
        #[arg(long, default_value = "third_party/ECOSYSTEM.toml")]
        manifest: PathBuf,
    },
}

pub fn run(cmd: Cmd) -> i32 {
    let res = match cmd {
        Cmd::Query { paths, file, query, lang, only, max_bytes, summary, cache } => {
            query::query(query::QueryArgs { paths, file, query, lang, only, max_bytes, summary, cache })
        }
        Cmd::Outline { file, json } => query::outline(&file, json),
        Cmd::Grammars { sync, write, json, manifest } => grammars::run(sync, write, json, &manifest),
    };
    match res {
        Ok(code) => code,
        Err(e) => {
            eprintln!("aphrody-code: {e}");
            1
        }
    }
}
