//! The engine: walk, skip what did not change, read/hash/detect in parallel, serve stage results
//! from the shared cache or compute them, write one SQLite transaction per chunk from a dedicated
//! writer thread, and hand heavy stages to the fleet queue.

use super::detect::{self, Detected, Detector, Kind};
use super::facts::Facts;
use super::shared::{self, Job, Shared};
use super::stages::{FileInfo, Stage, TextStage, TreeSitterStage};
use super::store::{FileRow, Store, Totals};
use crate::hash;
use crate::index::classify;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::sync_channel;
use std::time::Instant;

/// Chunk bounds: a Valkey round trip and a SQLite transaction per chunk.
const CHUNK_FILES: usize = 1024;
const CHUNK_BYTES: u64 = 256 << 20;
const MAX_BINARY: u64 = 512 << 20;
const MAX_IR: u64 = 64 << 20;
const SKIP_DIRS: [&str; 5] = ["node_modules", "target", ".git", "out", "graphify-out"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Deep {
    /// Heavy stages are not run.
    Off,
    /// Heavy stages are queued to the fleet; results are pulled by [`Engine::sync`].
    Queue,
    /// Heavy stages run in this process.
    Inline,
}

#[derive(Debug, Clone)]
pub struct Options {
    pub root: PathBuf,
    /// Sub-paths of `root` to walk (empty = all of it).
    pub include: Vec<PathBuf>,
    /// Also descend into gitignored trees (third_party clones).
    pub all: bool,
    pub db: PathBuf,
    pub deep: Deep,
    /// Read every file of unknown extension to detect it (Magika and magic bytes).
    pub sniff: bool,
    /// Re-run every stage even when size, mtime and hash match.
    pub force: bool,
    /// Write stage results to the shared cache.
    pub cache_write: bool,
    /// Consult the shared cache for cheap stages too (heavy stages always consult it).
    pub cache_cheap: bool,
    /// Upload the bytes of queued files so a worker without the checkout can fetch them.
    pub blobs: bool,
}

impl Options {
    pub fn new(root: impl Into<PathBuf>, db: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(), include: Vec::new(), all: false, db: db.into(), deep: Deep::Off, sniff: false,
            force: false, cache_write: false, cache_cheap: false, blobs: false,
        }
    }
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct Report {
    pub root: String,
    pub db: String,
    /// Files seen by the walk (or by the changed-path list).
    pub seen: usize,
    /// Files whose stages ran (new or changed content).
    pub changed: usize,
    /// mtime moved but the BLAKE3 matched: only `fstat` was refreshed.
    pub touched: usize,
    pub removed: usize,
    pub cache_hits: usize,
    pub cache_misses: usize,
    pub cache_writes: usize,
    pub queued: usize,
    pub deep_applied: usize,
    pub shared: bool,
    pub walk_ms: u128,
    pub total_ms: u128,
    pub totals: Totals,
}

#[derive(Debug, Clone)]
struct Entry {
    rel: String,
    abs: PathBuf,
    size: u64,
    mtime_ns: i64,
}

struct Prep {
    e: Entry,
    bytes: Option<Vec<u8>>,
    hash: String,
    det: Detected,
}

struct Done {
    row: FileRow,
    facts: Vec<Facts>,
    pending: Vec<(String, u32)>,
}

enum Msg {
    Apply(Vec<Done>),
    Touch(Vec<FileRow>),
    Remove(Vec<String>),
}

pub struct Engine {
    pub stages: Vec<Arc<dyn Stage>>,
    pub detectors: Vec<Arc<dyn Detector>>,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

fn now_ns() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos() as i64)
}

fn mtime_ns(md: &std::fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos() as i64)
}

fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

fn skipped(rel: &str) -> bool {
    rel.split('/').any(|c| SKIP_DIRS.contains(&c))
}

fn host_label() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "unknown".into())
}

impl Engine {
    /// Tree-sitter and document stages; add binary/IR stages and detectors with the `with_*` methods.
    pub fn new() -> Self {
        Self { stages: vec![Arc::new(TreeSitterStage), Arc::new(TextStage)], detectors: Vec::new() }
    }

    #[must_use]
    pub fn with_stage(mut self, s: impl Stage + 'static) -> Self {
        self.stages.push(Arc::new(s));
        self
    }

    #[must_use]
    pub fn with_detector(mut self, d: impl Detector + 'static) -> Self {
        self.detectors.push(Arc::new(d));
        self
    }

    fn walk(&self, o: &Options) -> Vec<Entry> {
        let roots: Vec<PathBuf> =
            if o.include.is_empty() { vec![o.root.clone()] } else { o.include.iter().map(|p| o.root.join(p)).collect() };
        let mut it = roots.iter();
        let Some(first) = it.next() else { return Vec::new() };
        let mut wb = ignore::WalkBuilder::new(first);
        for r in it {
            wb.add(r);
        }
        let walker = wb
            .git_ignore(!o.all)
            .git_exclude(!o.all)
            .hidden(true)
            .filter_entry(|e| !matches!(e.file_name().to_str(), Some(n) if SKIP_DIRS.contains(&n)))
            .build_parallel();
        let (tx, rx) = std::sync::mpsc::channel::<Entry>();
        let (root, sniff) = (&o.root, o.sniff);
        walker.run(|| {
            let tx = tx.clone();
            Box::new(move |res| {
                let Ok(ent) = res else { return ignore::WalkState::Continue };
                if !ent.file_type().is_some_and(|t| t.is_file()) {
                    return ignore::WalkState::Continue;
                }
                let p = ent.path();
                if !sniff && detect::by_name(p).is_none() {
                    return ignore::WalkState::Continue;
                }
                let Ok(md) = ent.metadata() else { return ignore::WalkState::Continue };
                let _ = tx.send(Entry { rel: rel_of(root, p), abs: p.to_path_buf(), size: md.len(), mtime_ns: mtime_ns(&md) });
                ignore::WalkState::Continue
            })
        });
        drop(tx);
        let mut v: Vec<Entry> = rx.into_iter().collect();
        v.sort_unstable_by(|a, b| a.rel.cmp(&b.rel));
        v
    }

    /// Read, hash and detect one file. Bytes are kept only when a stage may need them.
    fn prepare(&self, e: &Entry, o: &Options) -> Option<Prep> {
        let named = detect::by_name(&e.abs);
        let cap = match named.as_ref().map(|d| d.kind) {
            Some(Kind::Binary) => MAX_BINARY,
            Some(Kind::Ir) => MAX_IR,
            Some(Kind::Text) => super::stages::MAX_TEXT,
            _ => crate::index::MAX_PARSE_BYTES,
        };
        let bytes = if e.size <= cap { Some(std::fs::read(&e.abs).ok()?) } else { None };
        let (hash, det) = match &bytes {
            Some(b) => (hash::blake3_hex(b), detect::detect(&e.abs, &b[..b.len().min(8192)], &self.detectors)),
            None => {
                let head = read_head(&e.abs);
                let det = named.unwrap_or_else(|| detect::detect(&e.abs, &head, &[]));
                (hash::blake3_file_hex(&e.abs).ok()?, det)
            }
        };
        let _ = o;
        Some(Prep { e: e.clone(), bytes, hash, det })
    }

    fn row(p: &Prep) -> FileRow {
        let (layer, feature) = classify(&p.e.rel);
        FileRow {
            path: p.e.rel.clone(), layer, feature, hash: p.hash.clone(), size: p.e.size, mtime_ns: p.e.mtime_ns,
            kind: p.det.kind.as_str().to_string(), label: p.det.label.clone(), mime: p.det.mime.clone(), score: p.det.score,
        }
    }

    /// Full index of `o.root` (restricted to `o.include`): unchanged files cost one `stat`.
    pub fn index(&self, o: &Options, shared: Option<&mut Shared>) -> Result<Report, String> {
        let t0 = Instant::now();
        let store = Store::open(&o.db)?;
        let known = store.known()?;
        let entries = self.walk(o);
        let walk_ms = t0.elapsed().as_millis();
        let seen: HashSet<&str> = entries.iter().map(|e| e.rel.as_str()).collect();
        let prefixes: Vec<String> = o
            .include
            .iter()
            .map(|p| format!("{}/", p.to_string_lossy().replace('\\', "/").trim_matches('/')))
            .collect();
        let removed: Vec<String> = known
            .keys()
            .filter(|k| (prefixes.is_empty() || prefixes.iter().any(|p| k.starts_with(p.as_str()))) && !seen.contains(k.as_str()))
            .cloned()
            .collect();
        let n_seen = entries.len();
        let todo: Vec<Entry> = entries
            .into_iter()
            .filter(|e| o.force || known.get(&e.rel).is_none_or(|k| k.size != e.size || k.mtime_ns != e.mtime_ns))
            .collect();
        let mut rep = Report { seen: n_seen, walk_ms, ..Report::default() };
        self.process(store, todo, removed, &known, o, shared, &mut rep, t0)?;
        Ok(rep)
    }

    /// Incremental path for a watcher: only `paths` (absolute or relative to the root) are looked at.
    pub fn index_paths(&self, o: &Options, paths: &[PathBuf], shared: Option<&mut Shared>) -> Result<Report, String> {
        let t0 = Instant::now();
        let store = Store::open(&o.db)?;
        let known = store.known()?;
        let mut todo = Vec::new();
        let mut removed = Vec::new();
        let mut seen = HashSet::new();
        for p in paths {
            let abs = if p.is_absolute() { p.clone() } else { o.root.join(p) };
            let rel = rel_of(&o.root, &abs);
            if skipped(&rel) || (!o.sniff && detect::by_name(&abs).is_none()) || !seen.insert(rel.clone()) {
                continue;
            }
            match std::fs::metadata(&abs) {
                Ok(md) if md.is_file() => {
                    let e = Entry { rel: rel.clone(), abs, size: md.len(), mtime_ns: mtime_ns(&md) };
                    if o.force || known.get(&rel).is_none_or(|k| k.size != e.size || k.mtime_ns != e.mtime_ns) {
                        todo.push(e);
                    }
                }
                Ok(_) => {}
                Err(_) if known.contains_key(&rel) => removed.push(rel),
                Err(_) => {}
            }
        }
        let mut rep = Report { seen: seen.len(), ..Report::default() };
        self.process(store, todo, removed, &known, o, shared, &mut rep, t0)?;
        Ok(rep)
    }

    #[allow(clippy::too_many_arguments)]
    fn process(
        &self,
        store: Store,
        todo: Vec<Entry>,
        removed: Vec<String>,
        known: &HashMap<String, super::store::Known>,
        o: &Options,
        mut shared: Option<&mut Shared>,
        rep: &mut Report,
        t0: Instant,
    ) -> Result<(), String> {
        rep.root = o.root.to_string_lossy().replace('\\', "/");
        rep.db = o.db.to_string_lossy().replace('\\', "/");
        rep.removed = removed.len();
        rep.shared = shared.is_some();
        let host = host_label();
        let (tx, rx) = sync_channel::<Msg>(3);
        // First load of a database: no per-file resets, no FTS upkeep, indexes built once at the end.
        let cold = known.is_empty() && todo.len() >= 256;
        let outcome = std::thread::scope(|scope| -> Result<(u128, Totals), String> {
            let writer = scope.spawn(move || -> Result<Store, String> {
                if cold {
                    store.begin_bulk()?;
                }
                for msg in rx {
                    store.begin()?;
                    match msg {
                        Msg::Remove(paths) => {
                            for p in &paths {
                                store.remove(p)?;
                            }
                        }
                        Msg::Touch(rows) => {
                            for r in &rows {
                                store.touch(r)?;
                            }
                        }
                        Msg::Apply(done) => {
                            for d in done {
                                store.reset_file(&d.row.path)?;
                                store.put_file(&d.row)?;
                                for f in &d.facts {
                                    store.apply(&d.row.path, f)?;
                                }
                                for (stage, ver) in &d.pending {
                                    store.add_pending(&d.row.path, stage, *ver, &d.row.hash, now_ns())?;
                                }
                            }
                        }
                    }
                    store.commit()?;
                }
                if cold {
                    store.end_bulk()?;
                }
                Ok(store)
            });

            let mut produce = || -> Result<(), String> {
                if !removed.is_empty() {
                    tx.send(Msg::Remove(removed.clone())).map_err(|_| "writer stopped".to_string())?;
                }
                let mut i = 0;
                while i < todo.len() {
                    let (mut j, mut bytes) = (i, 0u64);
                    while j < todo.len() && j - i < CHUNK_FILES && (j == i || bytes + todo[j].size <= CHUNK_BYTES) {
                        bytes += todo[j].size;
                        j += 1;
                    }
                    self.chunk(&todo[i..j], known, o, &mut shared, &tx, rep, &host)?;
                    i = j;
                }
                Ok(())
            };
            let produced = produce();
            drop(tx);
            let store = writer.join().map_err(|_| "writer panicked".to_string())??;
            produced?;
            let totals = store.totals()?;
            let stats = serde_json::json!({
                "files": totals.files, "parsed": totals.parsed, "symbols": totals.symbols, "calls": totals.calls,
                "imports": totals.imports, "lines": totals.lines, "elapsed_ms": t0.elapsed().as_millis(),
            });
            store.set_meta("root", &rep.root)?;
            store.set_meta("stats", &stats.to_string())?;
            store.set_meta("indexed_at", &now_ns().to_string())?;
            Ok((t0.elapsed().as_millis(), totals))
        });
        let (total_ms, totals) = outcome?;
        rep.total_ms = total_ms;
        rep.totals = totals;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn chunk(
        &self,
        entries: &[Entry],
        known: &HashMap<String, super::store::Known>,
        o: &Options,
        shared: &mut Option<&mut Shared>,
        tx: &std::sync::mpsc::SyncSender<Msg>,
        rep: &mut Report,
        host: &str,
    ) -> Result<(), String> {
        let prepared: Vec<Prep> = entries.par_iter().filter_map(|e| self.prepare(e, o)).collect();
        let (same, changed): (Vec<Prep>, Vec<Prep>) =
            prepared.into_iter().partition(|p| !o.force && known.get(&p.e.rel).is_some_and(|k| k.hash == p.hash));
        if !same.is_empty() {
            rep.touched += same.len();
            tx.send(Msg::Touch(same.iter().map(Self::row).collect())).map_err(|_| "writer stopped".to_string())?;
        }
        if changed.is_empty() {
            return Ok(());
        }
        rep.changed += changed.len();

        // Cache lookups for this chunk, one pipelined round trip.
        let mut want: Vec<(usize, usize, String)> = Vec::new();
        for (pi, p) in changed.iter().enumerate() {
            let info = FileInfo { path: &p.e.rel, abs: &p.e.abs, size: p.e.size, hash: &p.hash, det: &p.det };
            for (si, s) in self.stages.iter().enumerate() {
                if s.accepts(&info) && (s.heavy() || o.cache_cheap) {
                    want.push((pi, si, shared::res_key(s.name(), s.version(), &p.hash)));
                }
            }
        }
        let mut cached: HashMap<(usize, usize), Facts> = HashMap::new();
        if let Some(sh) = shared.as_deref_mut()
            && !want.is_empty()
        {
            let keys: Vec<String> = want.iter().map(|w| w.2.clone()).collect();
            match sh.get_many(&keys) {
                Ok(vals) => {
                    for ((pi, si, _), v) in want.iter().zip(vals) {
                        match v.and_then(|b| serde_json::from_slice::<Facts>(&b).ok()) {
                            Some(f) => {
                                rep.cache_hits += 1;
                                cached.insert((*pi, *si), f);
                            }
                            None => rep.cache_misses += 1,
                        }
                    }
                }
                Err(_) => *shared = None,
            }
        }

        // Compute what the cache could not serve, in parallel.
        let results: Vec<(Done, Vec<(String, Vec<u8>)>, Vec<(usize, Job)>)> = changed
            .par_iter()
            .enumerate()
            .map(|(pi, p)| {
                let info = FileInfo { path: &p.e.rel, abs: &p.e.abs, size: p.e.size, hash: &p.hash, det: &p.det };
                let mut done = Done { row: Self::row(p), facts: Vec::new(), pending: Vec::new() };
                let mut puts = Vec::new();
                let mut jobs = Vec::new();
                for (si, s) in self.stages.iter().enumerate() {
                    if !s.accepts(&info) {
                        continue;
                    }
                    if let Some(f) = cached.get(&(pi, si)) {
                        done.facts.push(f.clone());
                        continue;
                    }
                    if s.heavy() && o.deep != Deep::Inline {
                        if o.deep == Deep::Queue {
                            done.pending.push((s.name().to_string(), s.version()));
                            jobs.push((
                                si,
                                Job {
                                    stage: s.name().into(), ver: s.version(), path: p.e.rel.clone(), hash: p.hash.clone(),
                                    size: p.e.size, kind: p.det.kind.as_str().into(), label: p.det.label.clone(), host: String::new(),
                                },
                            ));
                        }
                        continue;
                    }
                    let Some(bytes) = p.bytes.as_deref() else { continue };
                    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| s.run(&info, bytes)));
                    if let Ok(Ok(f)) = run {
                        if o.cache_write
                            && let Ok(json) = serde_json::to_vec(&f)
                        {
                            puts.push((shared::res_key(s.name(), s.version(), &p.hash), json));
                        }
                        done.facts.push(f);
                    }
                }
                (done, puts, jobs)
            })
            .collect();

        let mut dones = Vec::with_capacity(results.len());
        let mut puts = Vec::new();
        let mut jobs = Vec::new();
        for (pi, (d, pu, jb)) in results.into_iter().enumerate() {
            dones.push(d);
            puts.extend(pu);
            jobs.extend(jb.into_iter().map(|(_, mut j)| {
                j.host = host.to_string();
                (pi, j)
            }));
        }
        tx.send(Msg::Apply(dones)).map_err(|_| "writer stopped".to_string())?;

        if let Some(sh) = shared.as_deref_mut() {
            let mut ok = true;
            if !puts.is_empty() {
                ok &= sh.set_many(&puts, shared::RESULT_TTL_S).is_ok();
                rep.cache_writes += puts.len();
            }
            for (pi, j) in &jobs {
                if o.blobs
                    && let Some(b) = changed[*pi].bytes.as_deref()
                {
                    ok &= sh.put_blob(&j.hash, b).is_ok();
                }
                if ok {
                    let _ = sh.ensure_group("heavy");
                    match sh.enqueue("heavy", j, 600) {
                        Ok(true) => rep.queued += 1,
                        Ok(false) => {}
                        Err(_) => ok = false,
                    }
                }
            }
            if !ok {
                *shared = None;
            }
        }
        Ok(())
    }

    /// Pull finished deep results of `pending` rows from the shared cache into SQLite.
    pub fn sync(&self, db: &Path, shared: &mut Shared) -> Result<usize, String> {
        let store = Store::open(db)?;
        let pending = store.pending()?;
        if pending.is_empty() {
            return Ok(0);
        }
        let keys: Vec<String> = pending.iter().map(|(_, s, v, h)| shared::res_key(s, *v, h)).collect();
        let vals = shared.get_many(&keys)?;
        let known = store.known()?;
        let mut applied = 0;
        store.begin()?;
        for ((path, stage, _ver, hash), v) in pending.iter().zip(vals) {
            if known.get(path).is_none_or(|k| &k.hash != hash) {
                store.clear_pending(path, stage)?;
                continue;
            }
            if let Some(f) = v.and_then(|b| serde_json::from_slice::<Facts>(&b).ok()) {
                store.apply(path, &f)?;
                store.clear_pending(path, stage)?;
                applied += 1;
            }
        }
        store.commit()?;
        Ok(applied)
    }

    /// Run queued jobs of `role` until `stop` is set (or one batch when `once`). Files are read from
    /// `root` when the BLAKE3 matches, else from the shared blob. Returns the number of jobs done.
    pub fn work(&self, shared: &mut Shared, w: &WorkOptions, stop: &std::sync::atomic::AtomicBool) -> Result<usize, String> {
        use std::sync::atomic::Ordering;
        shared.ensure_group(&w.role)?;
        let mut done = 0;
        let batch = rayon::current_num_threads().max(1);
        while !stop.load(Ordering::Relaxed) {
            let jobs = shared.claim(&w.role, &w.consumer, batch, w.block_ms, 120_000)?;
            if jobs.is_empty() {
                if w.once {
                    break;
                }
                continue;
            }
            let mut blobs: HashMap<String, Vec<u8>> = HashMap::new();
            for (_, j) in &jobs {
                if !local_matches(&w.root, j)
                    && let Ok(Some(b)) = shared.get_blob(&j.hash)
                {
                    blobs.insert(j.hash.clone(), b);
                }
            }
            let outs: Vec<(String, Job, Option<Vec<u8>>)> = jobs
                .par_iter()
                .map(|(id, j)| (id.clone(), j.clone(), self.run_job(&w.root, j, blobs.get(&j.hash))))
                .collect();
            for (id, j, json) in outs {
                let json = json.unwrap_or_else(|| b"{}".to_vec());
                shared.set_many(&[(shared::res_key(&j.stage, j.ver, &j.hash), json)], shared::RESULT_TTL_S)?;
                let evt = serde_json::json!({"t": "res", "stage": j.stage, "ver": j.ver, "hash": j.hash, "path": j.path, "by": w.consumer});
                let _ = shared.publish(&evt.to_string());
                shared.ack(&w.role, &id)?;
                done += 1;
            }
            if w.once {
                break;
            }
        }
        Ok(done)
    }

    fn run_job(&self, root: &Path, j: &Job, blob: Option<&Vec<u8>>) -> Option<Vec<u8>> {
        let s = self.stages.iter().find(|s| s.name() == j.stage && s.version() == j.ver)?;
        let abs = root.join(&j.path);
        let bytes = match blob {
            Some(b) => b.clone(),
            None => std::fs::read(&abs).ok().filter(|b| hash::blake3_hex(b) == j.hash)?,
        };
        let det = Detected::new(Kind::parse(&j.kind), &j.label);
        let info = FileInfo { path: &j.path, abs: &abs, size: j.size, hash: &j.hash, det: &det };
        let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| s.run(&info, &bytes)));
        match run {
            Ok(Ok(f)) => serde_json::to_vec(&f).ok(),
            _ => None,
        }
    }
}

pub struct WorkOptions {
    pub root: PathBuf,
    pub role: String,
    pub consumer: String,
    pub block_ms: u64,
    pub once: bool,
}

fn local_matches(root: &Path, j: &Job) -> bool {
    std::fs::read(root.join(&j.path)).is_ok_and(|b| hash::blake3_hex(&b) == j.hash)
}

fn read_head(p: &Path) -> Vec<u8> {
    use std::io::Read;
    let mut buf = vec![0u8; 8192];
    let n = std::fs::File::open(p).and_then(|mut f| f.read(&mut buf)).unwrap_or(0);
    buf.truncate(n);
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ay-engine-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn incremental_index_skips_unchanged_and_follows_edits_and_deletes() {
        let root = tmp("inc");
        std::fs::write(root.join("a.rs"), "pub fn alpha_symbol() {}\n").unwrap();
        std::fs::write(root.join("b.rs"), "pub fn beta_symbol() { alpha_symbol(); }\n").unwrap();
        std::fs::write(root.join("notes.md"), "# Title\nthe quick brown fox\n").unwrap();
        let o = Options::new(&root, root.join("var/core.db"));
        let eng = Engine::new();

        let r1 = eng.index(&o, None).unwrap();
        assert_eq!((r1.seen, r1.changed, r1.touched), (3, 3, 0));
        assert_eq!(r1.totals.parsed, 2);
        assert!(r1.totals.symbols >= 2 && r1.totals.calls >= 1);

        let r2 = eng.index(&o, None).unwrap();
        assert_eq!((r2.changed, r2.touched, r2.removed), (0, 0, 0), "unchanged tree costs only stats");

        // Same bytes, new mtime: hash matches, nothing re-run.
        let mt = std::fs::metadata(root.join("a.rs")).unwrap().modified().unwrap() + std::time::Duration::from_secs(5);
        std::fs::File::options().write(true).open(root.join("a.rs")).unwrap().set_modified(mt).unwrap();
        let r3 = eng.index(&o, None).unwrap();
        assert_eq!((r3.changed, r3.touched), (0, 1));

        std::fs::write(root.join("a.rs"), "pub fn gamma_symbol() {}\npub fn delta_symbol() {}\n").unwrap();
        let r4 = eng.index_paths(&o, &[PathBuf::from("a.rs")], None).unwrap();
        assert_eq!(r4.changed, 1);
        let st = Store::open(&o.db).unwrap();
        assert!(st.lookup("alpha_symbol", 5).unwrap().is_empty());
        assert_eq!(st.search("delta", 5).unwrap().len(), 1);
        assert_eq!(st.text("quick", 5).unwrap().len(), 1);

        std::fs::remove_file(root.join("b.rs")).unwrap();
        let r5 = eng.index(&o, None).unwrap();
        assert_eq!(r5.removed, 1);
        assert_eq!(r5.totals.files, 2);
        let _ = std::fs::remove_dir_all(root);
    }

    struct Fake;
    impl Stage for Fake {
        fn name(&self) -> &'static str {
            "fake-deep"
        }
        fn version(&self) -> u32 {
            1
        }
        fn accepts(&self, f: &FileInfo<'_>) -> bool {
            f.det.kind == Kind::Binary
        }
        fn heavy(&self) -> bool {
            true
        }
        fn run(&self, _f: &FileInfo<'_>, bytes: &[u8]) -> Result<Facts, String> {
            Ok(Facts {
                funcs: vec![super::super::facts::FuncFact { name: "entry".into(), insns: bytes.len() as u32, kind: "native".into(), ..Default::default() }],
                ..Facts::default()
            })
        }
    }

    #[test]
    fn heavy_stage_runs_inline_and_records_functions() {
        let root = tmp("deep");
        std::fs::write(root.join("x.so"), b"\x7fELF\x02\x01\x01\0........").unwrap();
        let mut o = Options::new(&root, root.join("c.db"));
        o.deep = Deep::Inline;
        let eng = Engine::new().with_stage(Fake);
        let r = eng.index(&o, None).unwrap();
        assert_eq!(r.totals.funcs, 1);
        let _ = std::fs::remove_dir_all(root);
    }
}
