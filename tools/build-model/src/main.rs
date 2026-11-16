//! build-model: work/span analysis of a siso build.
//!
//! Inputs (all produced read-only on the builder):
//!   --graph   JSONL from `siso query graph -C <out>` (uncompressed)
//!   --run1    siso_metrics.0.json (first run), --run2 siso_metrics.json
//!   --retest  siso_metrics.json of the cache re-test
//!   --pool    name=host:slots:speed:overhead[,host:...] (repeatable)
//!   --target  ninja target (default headless_shell)
//!   --boot    bootstrap resamples (default 1000), --seed
//!   --link    comma list of final-link durations (s) for sensitivity
//! Output: plain text report on stdout.

use build_model::*;
use serde::Deserialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};

#[derive(Deserialize)]
struct G {
    output: String,
    #[serde(default)]
    extra_outputs: Vec<String>,
    #[serde(default)]
    inputs: Vec<String>,
    #[serde(default)]
    implicit_inputs: Vec<String>,
    #[serde(default)]
    order_only_inputs: Vec<String>,
    rule: String,
}

#[derive(Deserialize, Clone, Default)]
struct M {
    #[serde(default)]
    outputs: Vec<String>,
    run_nanos: Option<i64>,
    duration_nanos: Option<i64>,
    action_start_nanos: Option<i64>,
    action_end_nanos: Option<i64>,
    utime_nanos: Option<i64>,
    stime_nanos: Option<i64>,
    #[serde(default)]
    cached: bool,
    #[serde(default)]
    no_exec: bool,
    exec_start_nanos: Option<i64>,
    exec_nanos: Option<i64>,
    /// Processor-sharing normalisation to 12 concurrent processes: min(1, 12 / c)
    /// where c = number of processes running at the action's midpoint.
    #[serde(skip)]
    scale: f64,
}
impl M {
    /// Raw slot occupancy (s).
    fn raw(&self) -> f64 {
        self.run_nanos.or(self.duration_nanos).unwrap_or(0).max(0) as f64 / 1e9
    }
    /// Weight in fr1-slot-seconds at 12-way concurrency.
    fn w(&self) -> f64 {
        self.raw() * self.scale
    }
}

const REF_SLOTS: f64 = 12.0;

fn load_metrics(p: &str) -> Vec<M> {
    let f = BufReader::new(std::fs::File::open(p).unwrap_or_else(|e| panic!("{p}: {e}")));
    let mut v: Vec<M> = f
        .lines()
        .map_while(Result::ok)
        .filter_map(|l| serde_json::from_str::<M>(&l).ok())
        .filter(|m| !m.outputs.is_empty())
        .collect();
    // concurrency step function from exec intervals
    let mut ev: Vec<(i64, i32)> = Vec::new();
    for m in &v {
        if let (Some(s), Some(d)) = (m.exec_start_nanos, m.exec_nanos) {
            if d > 0 && s >= 0 {
                ev.push((s, 1));
                ev.push((s + d, -1));
            }
        }
    }
    ev.sort_unstable();
    let mut ts = Vec::with_capacity(ev.len());
    let mut cs = Vec::with_capacity(ev.len());
    let mut c = 0i32;
    for (t, d) in ev {
        c += d;
        ts.push(t);
        cs.push(c);
    }
    for m in &mut v {
        m.scale = 1.0;
        if let (Some(s), Some(d)) = (m.exec_start_nanos, m.exec_nanos) {
            if d > 0 && s >= 0 {
                let i = ts.partition_point(|&t| t <= s + d / 2);
                let conc = if i == 0 { 1 } else { cs[i - 1].max(1) } as f64;
                m.scale = (REF_SLOTS / conc).min(1.0);
            }
        }
    }
    v
}

fn class(rule: &str) -> &'static str {
    let r = rule;
    if r == "phony" {
        "phony"
    } else if r.starts_with("__") {
        "action"
    } else if r.ends_with("alink") {
        "alink"
    } else if r.ends_with("link") || r.ends_with("solink_module") {
        "link"
    } else if r.contains("rust") {
        "rust"
    } else if r.ends_with("cxx") || r.ends_with("cxx_module") {
        "cxx"
    } else if r.ends_with("cc") || r.ends_with("asm") {
        "cc"
    } else if r.ends_with("copy") || r.ends_with("stamp") {
        "copy"
    } else {
        "action"
    }
}

fn dirs(out: &str) -> (String, String) {
    let mut c: Vec<&str> = out.split('/').collect();
    c.pop();
    let mut i = 0;
    if c.first().is_some_and(|s| s.starts_with("clang_")) {
        i += 1;
    }
    if c.get(i).is_some_and(|s| *s == "obj" || *s == "gen") {
        i += 1;
    }
    let d1 = c.get(i).copied().unwrap_or("").to_string();
    let d2 = c[i.min(c.len())..].iter().take(2).copied().collect::<Vec<_>>().join("/");
    (d1, d2)
}

struct Args(HashMap<String, Vec<String>>);
impl Args {
    fn parse() -> Self {
        let mut m: HashMap<String, Vec<String>> = HashMap::new();
        let a: Vec<String> = std::env::args().skip(1).collect();
        let mut i = 0;
        while i + 1 < a.len() {
            m.entry(a[i].trim_start_matches("--").to_string()).or_default().push(a[i + 1].clone());
            i += 2;
        }
        Self(m)
    }
    fn get(&self, k: &str) -> Option<&str> {
        self.0.get(k).and_then(|v| v.last()).map(String::as_str)
    }
    fn all(&self, k: &str) -> Vec<String> {
        self.0.get(k).cloned().unwrap_or_default()
    }
}

struct Pool {
    name: String,
    slots: Vec<Slot>,
    desc: String,
}
fn parse_pool(s: &str) -> Pool {
    let (name, rest) = s.split_once('=').expect("pool name=...");
    let mut spec = Vec::new();
    for h in rest.split(',') {
        let f: Vec<&str> = h.split(':').collect();
        spec.push((f[1].parse().unwrap(), f[2].parse().unwrap(), f[3].parse().unwrap()));
    }
    Pool { name: name.into(), slots: slots(&spec), desc: rest.into() }
}

struct Model {
    dag: Dag,
    topo: Vec<u32>,
    target: u32,
    class: Vec<&'static str>,
    w_meas: Vec<Option<f64>>,
    run1: Vec<Option<M>>,
    pool_of: Vec<usize>,
    pools: Vec<Vec<f64>>,
    pool_names: Vec<String>,
}

fn build(a: &Args) -> Model {
    let target_name = a.get("target").unwrap_or("headless_shell");
    let f = BufReader::with_capacity(1 << 20, std::fs::File::open(a.get("graph").unwrap()).unwrap());
    let mut nodes: Vec<G> = Vec::new();
    for l in f.lines().map_while(Result::ok) {
        if let Ok(g) = serde_json::from_str::<G>(&l) {
            nodes.push(g);
        }
    }
    let mut prod: HashMap<&str, u32> = HashMap::new();
    for (i, g) in nodes.iter().enumerate() {
        prod.insert(g.output.as_str(), i as u32);
        for o in &g.extra_outputs {
            prod.insert(o.as_str(), i as u32);
        }
    }
    let t = prod[target_name];
    // backward reachability
    let mut id = vec![u32::MAX; nodes.len()];
    let mut order = vec![t];
    id[t as usize] = 0;
    let mut edges = Vec::new();
    let mut i = 0;
    while i < order.len() {
        let v = order[i];
        i += 1;
        let g = &nodes[v as usize];
        for inp in g.inputs.iter().chain(&g.implicit_inputs).chain(&g.order_only_inputs) {
            if let Some(&p) = prod.get(inp.as_str()) {
                if p == v {
                    continue;
                }
                if id[p as usize] == u32::MAX {
                    id[p as usize] = order.len() as u32;
                    order.push(p);
                }
                edges.push((p, v));
            }
        }
    }
    let n = order.len();
    let mut dag = Dag::new(n);
    for (p, v) in edges {
        dag.add_edge(id[p as usize], id[v as usize]);
    }
    dag.dedup();
    let topo = dag.topo().expect("cycle in build graph");

    let r1 = load_metrics(a.get("run1").unwrap());
    let r2 = load_metrics(a.get("run2").unwrap());
    let idx = |r: &Vec<M>| {
        let mut h: HashMap<String, usize> = HashMap::new();
        for (i, m) in r.iter().enumerate() {
            for o in &m.outputs {
                h.insert(o.clone(), i);
            }
        }
        h
    };
    let (h1, h2) = (idx(&r1), idx(&r2));
    let mut class_v = Vec::with_capacity(n);
    let mut w_meas = Vec::with_capacity(n);
    let mut run1 = Vec::with_capacity(n);
    let mut keys: Vec<[String; 3]> = Vec::with_capacity(n);
    for &v in &order {
        let g = &nodes[v as usize];
        let c = class(&g.rule);
        class_v.push(c);
        let outs = std::iter::once(&g.output).chain(&g.extra_outputs);
        let m1 = outs.clone().find_map(|o| h1.get(o)).map(|&i| r1[i].clone());
        let m2 = outs.clone().find_map(|o| h2.get(o)).map(|&i| r2[i].clone());
        w_meas.push(if c == "phony" { Some(0.0) } else { m2.as_ref().or(m1.as_ref()).map(M::w) });
        run1.push(m1);
        let (d1, d2) = dirs(&g.output);
        keys.push([format!("{c}|{d2}"), format!("{c}|{d1}"), c.to_string()]);
    }
    // empirical pools, hierarchical with n >= 5
    let mut pool_map: HashMap<String, Vec<f64>> = HashMap::new();
    for (k, w) in keys.iter().zip(&w_meas) {
        if let (Some(w), false) = (w, k[2] == "phony") {
            for kk in k {
                pool_map.entry(kk.clone()).or_default().push(*w);
            }
        }
    }
    let mut pool_names: Vec<String> = Vec::new();
    let mut pools: Vec<Vec<f64>> = Vec::new();
    let mut pidx: HashMap<String, usize> = HashMap::new();
    let mut pool_of = vec![usize::MAX; n];
    for (v, k) in keys.iter().enumerate() {
        if w_meas[v].is_some() {
            continue;
        }
        let chosen = k.iter().find(|kk| pool_map.get(*kk).is_some_and(|p| p.len() >= 5));
        let kk = chosen.cloned().unwrap_or_else(|| "action".into());
        let j = *pidx.entry(kk.clone()).or_insert_with(|| {
            pool_names.push(kk.clone());
            pools.push(pool_map.get(&kk).cloned().unwrap_or_else(|| vec![0.0]));
            pools.len() - 1
        });
        pool_of[v] = j;
    }
    eprintln!("graph nodes {} reachable {} run1 steps {} run2 steps {}", nodes.len(), n, r1.len(), r2.len());
    Model { dag, topo, target: 0, class: class_v, w_meas, run1, pool_of, pools, pool_names }
}

struct Res {
    t1: f64,
    tinf: f64,
    b12: (f64, f64),
    sim12: f64,
    pools: Vec<((f64, f64), f64)>,
}

fn evaluate(m: &Model, w: &[f64], pools: &[Pool]) -> Res {
    let t1 = work(w);
    let (tinf, _) = critical_path(&m.dag, &m.topo, w);
    let p12 = slots(&[(12, 1.0, 0.0)]);
    let sim12 = makespan(&list_schedule(&m.dag, &m.topo, w, &p12, Prio::CriticalPath));
    let pr = pools
        .iter()
        .map(|p| {
            let b = related_bounds(&m.dag, &m.topo, w, &p.slots);
            (b, makespan(&list_schedule(&m.dag, &m.topo, w, &p.slots, Prio::CriticalPath)))
        })
        .collect();
    Res { t1, tinf, b12: brent_bounds(t1, tinf, 12), sim12, pools: pr }
}

fn h(s: f64) -> String {
    format!("{:.0} s ({:.2} h)", s, s / 3600.0)
}
fn ci(v: &mut [f64]) -> String {
    v.sort_by(f64::total_cmp);
    format!(
        "median {:.0} s [95 % {:.0}–{:.0}] ({:.2} h [{:.2}–{:.2}])",
        quantile_sorted(v, 0.5),
        quantile_sorted(v, 0.025),
        quantile_sorted(v, 0.975),
        quantile_sorted(v, 0.5) / 3600.0,
        quantile_sorted(v, 0.025) / 3600.0,
        quantile_sorted(v, 0.975) / 3600.0
    )
}

fn scenario(name: &str, m: &Model, base: &[f64], imputed: &[usize], pools: &[Pool], boot: usize, rng: &mut Rng) {
    println!("\n## scenario {name}");
    let exec = base.iter().filter(|&&x| x > 0.0).count();
    let imp_w: f64 = imputed.iter().map(|&v| base[v]).sum();
    println!("actions to run {exec}, imputed {} ({:.1} %), imputed share of T1 (point) {:.1} %",
        imputed.len(), 100.0 * imputed.len() as f64 / exec.max(1) as f64, 100.0 * imp_w / work(base));
    let r = evaluate(m, base, pools);
    let (_, path) = critical_path(&m.dag, &m.topo, base);
    println!("point: T1 {} Tinf {} | p=12 bounds [{:.0}, {:.0}] s, greedy-CP sim {}", h(r.t1), h(r.tinf), r.b12.0, r.b12.1, h(r.sim12));
    for (p, (b, s)) in pools.iter().zip(&r.pools) {
        println!("point: pool {} ({}) bounds [{:.0}, {:.0}] s, sim {}", p.name, p.desc, b.0, b.1, h(*s));
    }
    let cp_meas: f64 = path.iter().filter(|&&v| m.w_meas[v as usize].is_some()).map(|&v| base[v as usize]).sum();
    println!("critical path: {} nodes, measured share {:.1} %", path.iter().filter(|&&v| base[v as usize] > 0.0).count(), 100.0 * cp_meas / r.tinf.max(1e-9));
    if boot == 0 || imputed.is_empty() {
        return;
    }
    let mut t1s = Vec::new();
    let mut tis = Vec::new();
    let mut lo12 = Vec::new();
    let mut hi12 = Vec::new();
    let mut s12 = Vec::new();
    let mut pl: Vec<[Vec<f64>; 3]> = pools.iter().map(|_| [Vec::new(), Vec::new(), Vec::new()]).collect();
    let mut w = base.to_vec();
    for _ in 0..boot {
        for &v in imputed {
            let p = &m.pools[m.pool_of[v]];
            w[v] = p[rng.below(p.len())];
        }
        let r = evaluate(m, &w, pools);
        t1s.push(r.t1);
        tis.push(r.tinf);
        lo12.push(r.b12.0);
        hi12.push(r.b12.1);
        s12.push(r.sim12);
        for (acc, (b, s)) in pl.iter_mut().zip(&r.pools) {
            acc[0].push(b.0);
            acc[1].push(b.1);
            acc[2].push(*s);
        }
    }
    println!("bootstrap B={boot}: T1 {}", ci(&mut t1s));
    println!("bootstrap: Tinf {}", ci(&mut tis));
    println!("bootstrap: p=12 lower {}", ci(&mut lo12));
    println!("bootstrap: p=12 upper {}", ci(&mut hi12));
    println!("bootstrap: p=12 sim {}", ci(&mut s12));
    for (p, acc) in pools.iter().zip(pl.iter_mut()) {
        println!("bootstrap: pool {} lower {}", p.name, ci(&mut acc[0]));
        println!("bootstrap: pool {} upper {}", p.name, ci(&mut acc[1]));
        println!("bootstrap: pool {} sim {}", p.name, ci(&mut acc[2]));
    }
}

fn main() {
    let a = Args::parse();
    let boot: usize = a.get("boot").map_or(1000, |s| s.parse().unwrap());
    let mut rng = Rng::new(a.get("seed").map_or(20261112, |s| s.parse().unwrap()));
    let pools: Vec<Pool> = a.all("pool").iter().map(|s| parse_pool(s)).collect();
    let m = build(&a);
    let n = m.dag.len();

    // classes summary
    let mut by: HashMap<&str, (usize, usize, f64)> = HashMap::new();
    for v in 0..n {
        let e = by.entry(m.class[v]).or_default();
        e.0 += 1;
        if let Some(w) = m.w_meas[v] {
            e.1 += 1;
            e.2 += w;
        }
    }
    let mut cl: Vec<_> = by.into_iter().collect();
    cl.sort_by_key(|x| std::cmp::Reverse(x.1.0));
    println!("# classes (nodes, measured, measured slot-s)");
    for (c, (k, mm, s)) in &cl {
        println!("{c}: {k} {mm} {s:.0}");
    }
    let tgt = m.target as usize;
    println!("target node class {} measured {:?} imputation pool {} (n={}, mean {:.1} s, max {:.1} s)",
        m.class[tgt], m.w_meas[tgt],
        m.pool_names.get(m.pool_of[tgt]).map_or("-", |s| s.as_str()),
        m.pools.get(m.pool_of[tgt]).map_or(0, |p| p.len()),
        m.pools.get(m.pool_of[tgt]).map_or(0.0, |p| mean(p)),
        m.pools.get(m.pool_of[tgt]).map_or(0.0, |p| p.iter().copied().fold(0.0, f64::max)));

    // point weights: measured, else pool mean
    let point: Vec<f64> = (0..n).map(|v| m.w_meas[v].unwrap_or_else(|| mean(&m.pools[m.pool_of[v]]))).collect();
    let imputed: Vec<usize> = (0..n).filter(|&v| m.w_meas[v].is_none()).collect();

    // ---- cold full build
    scenario("cold (all reachable actions)", &m, &point, &imputed, &pools, boot, &mut rng);
    // ---- remaining after run 2
    let rem: Vec<f64> = (0..n).map(|v| if m.w_meas[v].is_some() { 0.0 } else { point[v] }).collect();
    scenario("remaining (not run in run1/run2)", &m, &rem, &imputed, &pools, boot, &mut rng);

    // ---- final-link sensitivity (point weights)
    println!("\n## final link sensitivity (L = duration of node `{}`)", a.get("target").unwrap_or("headless_shell"));
    for l in a.get("link").unwrap_or("").split(',').filter(|s| !s.is_empty()) {
        let l: f64 = l.parse().unwrap();
        for (name, base) in [("cold", &point), ("remaining", &rem)] {
            let mut w = base.clone();
            w[tgt] = l;
            let r = evaluate(&m, &w, &pools);
            let ps: Vec<String> = pools.iter().zip(&r.pools).map(|(p, (b, s))| format!("{} [{:.0},{:.0}] sim {:.0}", p.name, b.0, b.1, s)).collect();
            println!("L={l:.0} {name}: T1 {:.0} Tinf {:.0} p12 [{:.0},{:.0}] sim {:.0} | {}", r.t1, r.tinf, r.b12.0, r.b12.1, r.sim12, ps.join(" | "));
        }
    }

    // ---- CPU efficiency from run 1 (per-minute samples)
    let r1all = load_metrics(a.get("run1").unwrap());
    let mut bins: Vec<f64> = Vec::new();
    let (mut cpu_sum, mut run_sum) = (0.0, 0.0);
    let mut tmax = 0.0f64;
    for s in &r1all {
        let (Some(st), Some(en)) = (s.action_start_nanos, s.action_end_nanos) else { continue };
        let cpu = (s.utime_nanos.unwrap_or(0) + s.stime_nanos.unwrap_or(0)) as f64 / 1e9;
        if s.no_exec || cpu <= 0.0 {
            continue;
        }
        cpu_sum += cpu;
        run_sum += s.raw();
        let (st, en) = (st as f64 / 1e9, (en as f64 / 1e9).max(st as f64 / 1e9 + 1e-6));
        tmax = tmax.max(en);
        let need = (en / 60.0) as usize + 1;
        if bins.len() < need {
            bins.resize(need, 0.0);
        }
        let rate = cpu / (en - st);
        let mut t = st;
        while t < en {
            let b = (t / 60.0) as usize;
            let e = ((b + 1) as f64 * 60.0).min(en);
            bins[b] += rate * (e - t);
            t = e;
        }
    }
    let full = (tmax / 60.0) as usize; // drop last partial minute
    let cores: Vec<f64> = bins[..full.min(bins.len())].iter().map(|c| c / 60.0).collect();
    let (clo, chi) = block_bootstrap_mean_ci(&cores, 15, 2000, &mut rng);
    println!("\n## CPU efficiency run1 (child rusage utime+stime, per-minute bins, n={} min)", cores.len());
    println!("effective cores: mean {:.2} [95 % block-bootstrap(15 min) {:.2}–{:.2}], median {:.2}, IQR {:.2}–{:.2}",
        mean(&cores), clo, chi, quantile(&cores, 0.5), quantile(&cores, 0.25), quantile(&cores, 0.75));
    println!("eta = cores/12: mean {:.3} [{:.3}–{:.3}]; rho = sum cpu / sum slot-time = {:.3}", mean(&cores) / 12.0, clo / 12.0, chi / 12.0, cpu_sum / run_sum);
    let q15: Vec<String> = cores.chunks(15).map(|c| format!("{:.1}", mean(c))).collect();
    println!("15-min means: {}", q15.join(" "));

    // ---- hindcast run 1
    hindcast(&m, &mut rng);

    // ---- cache
    if let Some(p) = a.get("retest") {
        let rt = load_metrics(p);
        let k = rt.iter().filter(|s| s.cached).count() as u64;
        let nn = rt.iter().filter(|s| s.cached || (!s.no_exec && s.w() > 0.0)).count() as u64;
        let (lo, hi) = wilson(k, nn, 1.96);
        let hits: Vec<f64> = rt.iter().filter(|s| s.cached).map(|s| s.duration_nanos.unwrap_or(0) as f64 / 1e9).collect();
        let c_hit = if hits.is_empty() { 0.0 } else { mean(&hits) };
        println!("\n## cache: hits {k}/{nn}, Wilson 95 % [{lo:.3}, {hi:.3}], hit cost (duration) mean {c_hit:.3} s n={}", hits.len());
        for hh in [lo, 0.95, 1.0] {
            let w: Vec<f64> = (0..n).map(|v| {
                if point[v] == 0.0 || v == tgt { point[v] } else { hh * c_hit + (1.0 - hh) * point[v] }
            }).collect();
            let r = evaluate(&m, &w, &pools);
            let ps: Vec<String> = pools.iter().zip(&r.pools).map(|(p, (b, s))| format!("{} [{:.0},{:.0}] sim {:.0}", p.name, b.0, b.1, s)).collect();
            println!("h={hh:.3}: T1 {:.0} Tinf {:.0} p12 [{:.0},{:.0}] sim {:.0} | {}", r.t1, r.tinf, r.b12.0, r.b12.1, r.sim12, ps.join(" | "));
        }
    }
}

fn hindcast(m: &Model, rng: &mut Rng) {
    let sel: Vec<usize> = (0..m.dag.len()).filter(|&v| m.run1[v].as_ref().is_some_and(|s| s.action_end_nanos.is_some())).collect();
    let mut nid = vec![u32::MAX; m.dag.len()];
    for (i, &v) in sel.iter().enumerate() {
        nid[v] = i as u32;
    }
    let mut g = Dag::new(sel.len());
    for &u in &sel {
        for &v in &m.dag.succ[u] {
            if nid[v as usize] != u32::MAX {
                g.add_edge(nid[u], nid[v as usize]);
            }
        }
    }
    g.dedup();
    let topo = g.topo().unwrap();
    let s1: Vec<&M> = sel.iter().map(|&v| m.run1[v].as_ref().unwrap()).collect();
    let t0 = s1.iter().filter_map(|s| s.action_start_nanos).min().unwrap() as f64 / 1e9;
    let actual: Vec<f64> = s1.iter().map(|s| s.action_end_nanos.unwrap() as f64 / 1e9 - t0).collect();
    let w: Vec<f64> = s1.iter().map(|s| s.w()).collect();
    let raw_sum: f64 = s1.iter().map(|s| s.raw()).sum();
    let scaled = s1.iter().filter(|s| s.scale < 1.0).count();
    println!("run1 slot-time raw {:.0} s, normalised to 12-way {:.0} s ({} of {} steps scaled by 12/c)", raw_sum, work(&w), scaled, s1.len());
    let am = makespan(&actual);
    println!("\n## hindcast run1: {} steps present in current graph, actual span {}", sel.len(), h(am));
    let p12 = slots(&[(12, 1.0, 0.0)]);
    let (tinf, _) = critical_path(&g, &topo, &w);
    let (lo, hi) = brent_bounds(work(&w), tinf, 12);
    println!("run1 subgraph: T1 {} Tinf {} bounds p=12 [{:.0}, {:.0}] s; actual inside bounds: {}", h(work(&w)), h(tinf), lo, hi, am >= lo && am <= hi);
    let report = |label: &str, f: &[f64]| {
        let pm = makespan(f);
        let tm = am.max(pm);
        let grid: Vec<f64> = (0..=((tm / 60.0) as usize + 1)).map(|i| i as f64 * 60.0).collect();
        let (mx, me) = curve_error(&completion_curve(f, &grid), &completion_curve(&actual, &grid));
        let (wx, wm) = curve_error(&weighted_completion_curve(f, &w, &grid), &weighted_completion_curve(&actual, &w, &grid));
        println!("{label}: predicted span {} (error {:+.1} %), action-count fraction error max {:.3} mean {:.3}; work-fraction error max {:.3} mean {:.3}", h(pm), 100.0 * (pm - am) / am, mx, me, wx, wm);
        (pm, mx, me)
    };
    report("sim FIFO p=12 measured w", &list_schedule(&g, &topo, &w, &p12, Prio::Fifo));
    report("sim CP   p=12 measured w", &list_schedule(&g, &topo, &w, &p12, Prio::CriticalPath));
    // 2-fold-style CV: impute a random half from pools built on the other half (class|dir2 -> class)
    let mut errs = Vec::new();
    let mut spans = Vec::new();
    for _ in 0..20 {
        let hold: Vec<bool> = (0..sel.len()).map(|_| rng.unit() < 0.5).collect();
        let mut pm: HashMap<String, Vec<f64>> = HashMap::new();
        let key = |i: usize| {
            let c = m.class[sel[i]];
            let (d1, d2) = dirs(&s1[i].outputs[0]);
            [format!("{c}|{d2}"), format!("{c}|{d1}"), c.to_string()]
        };
        let keys: Vec<[String; 3]> = (0..sel.len()).map(key).collect();
        for i in 0..sel.len() {
            if !hold[i] {
                for k in &keys[i] {
                    pm.entry(k.clone()).or_default().push(w[i]);
                }
            }
        }
        let wi: Vec<f64> = (0..sel.len()).map(|i| {
            if !hold[i] { return w[i]; }
            match keys[i].iter().find_map(|k| pm.get(k).filter(|p| p.len() >= 5)) {
                Some(p) => p[rng.below(p.len())],
                None => w[i],
            }
        }).collect();
        let f = list_schedule(&g, &topo, &wi, &p12, Prio::Fifo);
        let pmk = makespan(&f);
        let grid: Vec<f64> = (0..=((am.max(pmk) / 60.0) as usize + 1)).map(|i| i as f64 * 60.0).collect();
        errs.push(curve_error(&completion_curve(&f, &grid), &completion_curve(&actual, &grid)).0);
        spans.push(100.0 * (pmk - am) / am);
    }
    println!("CV (50 % durations imputed, 20 reps, FIFO): span error median {:+.1} % [min {:+.1}, max {:+.1}], curve max-error median {:.3} [max {:.3}]",
        quantile(&spans, 0.5), quantile(&spans, 0.0), quantile(&spans, 1.0), quantile(&errs, 0.5), quantile(&errs, 1.0));
}
