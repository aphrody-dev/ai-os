//! `grammars`: the compiled grammar registry, and `--sync` to compare it with the upstream grammar lists
//! (GitHub orgs `tree-sitter` and `tree-sitter-grammars`) and add new grammars to `third_party/ECOSYSTEM.toml`,
//! which `system/core/build.rs` turns into the registry. Nothing is written by hand.

use crate::{GRAMMARS, SupportedLanguage};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::Path;

const ORGS: [&str; 2] = ["tree-sitter", "tree-sitter-grammars"];

#[derive(Debug, Clone, PartialEq)]
pub struct Upstream {
    pub name: String,
    pub url: String,
    pub branch: String,
    pub full_name: String,
}

/// Public, non-archived `tree-sitter-*` repositories of one page of `orgs/<org>/repos`.
pub fn parse_page(page: &Value) -> Vec<Upstream> {
    page.as_array()
        .into_iter()
        .flatten()
        .filter(|r| !r["archived"].as_bool().unwrap_or(false) && !r["fork"].as_bool().unwrap_or(false))
        .filter_map(|r| {
            let name = r["name"].as_str()?;
            name.starts_with("tree-sitter-").then(|| Upstream {
                name: name.to_string(),
                url: format!("{}.git", r["html_url"].as_str().unwrap_or_default()),
                branch: r["default_branch"].as_str().unwrap_or("main").to_string(),
                full_name: r["full_name"].as_str().unwrap_or(name).to_string(),
            })
        })
        .collect()
}

fn norm(url: &str) -> String {
    url.trim_end_matches(".git").trim_end_matches('/').to_ascii_lowercase()
}

/// Repositories that the manifest does not list by URL or by entry name.
pub fn missing(manifest: &toml::Table, upstream: &[Upstream]) -> Vec<Upstream> {
    let entries = manifest.get("entry").and_then(|e| e.as_table());
    let urls: BTreeSet<String> = entries
        .into_iter()
        .flat_map(|t| t.values())
        .filter_map(|v| v.get("url").and_then(|u| u.as_str()).map(norm))
        .collect();
    let mut seen = BTreeSet::new();
    upstream
        .iter()
        .filter(|u| !urls.contains(&norm(&u.url)) && !entries.is_some_and(|t| t.contains_key(&u.name)) && seen.insert(u.name.clone()))
        .cloned()
        .collect()
}

pub fn entry_block(u: &Upstream, sha: &str) -> String {
    format!(
        "\n[entry.{n}]\npath = \"third_party/{n}\"\nurl = \"{url}\"\nsha = \"{sha}\"\nkind = \"grammar\"\nused_by = [\"system/core\"]\nstatus = \"candidate\"\n",
        n = u.name,
        url = u.url
    )
}

fn token() -> Option<String> {
    ["GITHUB_TOKEN", "GH_TOKEN"].iter().find_map(|k| std::env::var(k).ok()).filter(|t| !t.is_empty())
}

fn get(url: &str) -> Result<Value, String> {
    let mut req = ureq::get(url).header("User-Agent", "aphrody-code").header("Accept", "application/vnd.github+json");
    if let Some(t) = token() {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    let mut resp = req.call().map_err(|e| format!("{url}: {e}"))?;
    resp.body_mut().read_json::<Value>().map_err(|e| format!("{url}: {e}"))
}

fn fetch_upstream() -> Result<Vec<Upstream>, String> {
    let mut all = Vec::new();
    for org in ORGS {
        for page in 1..=20 {
            let body = get(&format!("https://api.github.com/orgs/{org}/repos?type=public&per_page=100&page={page}"))?;
            if body.as_array().is_none_or(Vec::is_empty) {
                break;
            }
            all.extend(parse_page(&body));
        }
    }
    Ok(all)
}

pub fn run(sync: bool, write: bool, as_json: bool, manifest: &Path) -> Result<i32, String> {
    if !sync {
        let core: Vec<_> = SupportedLanguage::ALL.iter().map(|l| l.name()).collect();
        let registry: Vec<Value> = GRAMMARS
            .iter()
            .map(|g| json!({"name": g.name, "file_types": g.file_types, "tags": g.tags.is_some()}))
            .collect();
        if as_json {
            println!("{}", json!({"dedicated": core, "registry": registry, "manifest": manifest.to_string_lossy().replace('\\', "/")}));
        } else {
            println!("dedicated: {}", core.join(" "));
            println!("markdown: block grammar (tree-sitter-md)");
            for g in GRAMMARS {
                println!("registry: {:<24} {}{}", g.name, g.file_types.join(","), if g.tags.is_some() { " [tags]" } else { "" });
            }
            eprintln!("{} dedicated, {} registry grammars", core.len(), GRAMMARS.len());
        }
        return Ok(0);
    }
    let text = std::fs::read_to_string(manifest).map_err(|e| format!("{}: {e}", manifest.display()))?;
    let table: toml::Table = text.parse().map_err(|e| format!("{}: {e}", manifest.display()))?;
    let todo = missing(&table, &fetch_upstream()?);
    if as_json {
        println!("{}", json!({"missing": todo.iter().map(|u| json!({"name": u.name, "url": u.url})).collect::<Vec<_>>()}));
    } else {
        for u in &todo {
            println!("{}\t{}", u.name, u.url);
        }
        eprintln!("{} upstream grammar(s) not in {}", todo.len(), manifest.display());
    }
    if write && !todo.is_empty() {
        let mut out = text;
        for u in &todo {
            let b = get(&format!("https://api.github.com/repos/{}/branches/{}", u.full_name, u.branch))?;
            let sha = b["commit"]["sha"].as_str().ok_or_else(|| format!("{}: no commit sha", u.full_name))?;
            out.push_str(&entry_block(u, sha));
        }
        std::fs::write(manifest, out).map_err(|e| e.to_string())?;
        eprintln!("{} entr(ies) appended with status = \"candidate\"", todo.len());
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_filters_and_manifest_diff() {
        let page = json!([
            {"name": "tree-sitter-zig", "html_url": "https://github.com/tree-sitter-grammars/tree-sitter-zig", "default_branch": "master", "full_name": "tree-sitter-grammars/tree-sitter-zig"},
            {"name": "tree-sitter-old", "html_url": "https://github.com/tree-sitter/tree-sitter-old", "archived": true},
            {"name": "tree-sitter-fork", "html_url": "https://github.com/tree-sitter/tree-sitter-fork", "fork": true},
            {"name": "website", "html_url": "https://github.com/tree-sitter/website"},
            {"name": "tree-sitter-new", "html_url": "https://github.com/tree-sitter/tree-sitter-new", "default_branch": "main", "full_name": "tree-sitter/tree-sitter-new"},
        ]);
        let up = parse_page(&page);
        assert_eq!(up.iter().map(|u| u.name.as_str()).collect::<Vec<_>>(), ["tree-sitter-zig", "tree-sitter-new"]);
        let manifest: toml::Table = "[entry.tree-sitter-zig]\nurl = \"https://github.com/Tree-Sitter-Grammars/tree-sitter-zig.git\"\n".parse().unwrap();
        let todo = missing(&manifest, &up);
        assert_eq!(todo.len(), 1);
        assert_eq!(todo[0].name, "tree-sitter-new");
        let block = entry_block(&todo[0], "abc");
        let parsed: toml::Table = block.parse().unwrap();
        assert_eq!(parsed["entry"]["tree-sitter-new"]["kind"].as_str(), Some("grammar"));
    }
}
