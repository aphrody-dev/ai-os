//! Work/span model of a build DAG.
//!
//! Notation: nodes = actions, edge u -> v when v consumes an output of u,
//! w(v) >= 0 = slot-seconds of v. T1 = sum w, Tinf = longest weighted path.
//! Identical slots (Graham 1966/1969, Brent 1974): any greedy list schedule on
//! p slots satisfies max(T1/p, Tinf) <= Tp <= T1/p + Tinf.
//! Related slots with speeds s_i (duration on slot i = w/s_i + o_i):
//!   lower: Tp >= max(T1 / sum s_i, Tinf / s_max)
//!   upper (greedy): Tp <= sum(d)/p + CP(d) with d = w/s_min + o_max
//!   (same argument as Graham: at every instant either all p slots are busy,
//!   each consuming d-work at rate >= 1 when measured in d-units, or a ready
//!   task of a longest remaining d-chain is running).

use std::cmp::Ordering;
use std::collections::BinaryHeap;

#[derive(Clone, Debug, Default)]
pub struct Dag {
    pub succ: Vec<Vec<u32>>,
    pub npred: Vec<u32>,
}

impl Dag {
    pub fn new(n: usize) -> Self {
        Self { succ: vec![Vec::new(); n], npred: vec![0; n] }
    }
    pub fn len(&self) -> usize {
        self.succ.len()
    }
    pub fn is_empty(&self) -> bool {
        self.succ.is_empty()
    }
    /// Edge u before v. Call `dedup` once after all insertions.
    pub fn add_edge(&mut self, u: u32, v: u32) {
        self.succ[u as usize].push(v);
    }
    pub fn dedup(&mut self) {
        self.npred.iter_mut().for_each(|c| *c = 0);
        for s in &mut self.succ {
            s.sort_unstable();
            s.dedup();
        }
        for s in &self.succ {
            for &v in s {
                self.npred[v as usize] += 1;
            }
        }
    }
    /// Kahn topological order; None if the graph has a cycle.
    pub fn topo(&self) -> Option<Vec<u32>> {
        let mut indeg = self.npred.clone();
        let mut order: Vec<u32> =
            (0..self.len() as u32).filter(|&v| indeg[v as usize] == 0).collect();
        let mut i = 0;
        while i < order.len() {
            let u = order[i] as usize;
            i += 1;
            for &v in &self.succ[u] {
                indeg[v as usize] -= 1;
                if indeg[v as usize] == 0 {
                    order.push(v);
                }
            }
        }
        (order.len() == self.len()).then_some(order)
    }
}

pub fn work(w: &[f64]) -> f64 {
    w.iter().sum()
}

/// Longest path by DP in topological order: f(v) = w(v) + max_{u->v} f(u).
/// Returns (Tinf, path from source to sink).
pub fn critical_path(dag: &Dag, topo: &[u32], w: &[f64]) -> (f64, Vec<u32>) {
    let n = dag.len();
    let mut start = vec![0.0f64; n];
    let mut f = vec![0.0f64; n];
    let mut best = vec![u32::MAX; n];
    for &u in topo {
        let u = u as usize;
        f[u] = start[u] + w[u];
        for &v in &dag.succ[u] {
            let v = v as usize;
            if best[v] == u32::MAX || f[u] > start[v] {
                start[v] = f[u];
                best[v] = u as u32;
            }
        }
    }
    let (mut end, mut len) = (u32::MAX, f64::NEG_INFINITY);
    for v in 0..n {
        if f[v] > len {
            len = f[v];
            end = v as u32;
        }
    }
    if end == u32::MAX {
        return (0.0, Vec::new());
    }
    let mut path = vec![end];
    while best[*path.last().unwrap() as usize] != u32::MAX {
        path.push(best[*path.last().unwrap() as usize]);
    }
    path.reverse();
    (len, path)
}

/// Bottom level b(v) = w(v) + max_{v->x} b(x) (critical-path list priority).
pub fn bottom_levels(dag: &Dag, topo: &[u32], w: &[f64]) -> Vec<f64> {
    let mut b = vec![0.0f64; dag.len()];
    for &u in topo.iter().rev() {
        let u = u as usize;
        let m = dag.succ[u].iter().map(|&x| b[x as usize]).fold(0.0, f64::max);
        b[u] = w[u] + m;
    }
    b
}

/// Graham/Brent bounds for p identical slots.
pub fn brent_bounds(t1: f64, tinf: f64, p: usize) -> (f64, f64) {
    let p = p as f64;
    ((t1 / p).max(tinf), t1 / p + tinf)
}

#[derive(Clone, Copy, Debug)]
pub struct Slot {
    pub speed: f64,
    pub overhead: f64,
}

pub fn slots(spec: &[(usize, f64, f64)]) -> Vec<Slot> {
    spec.iter()
        .flat_map(|&(n, speed, overhead)| std::iter::repeat_n(Slot { speed, overhead }, n))
        .collect()
}

/// Bounds for related slots (see module doc). Upper bound needs the DAG
/// because CP(d) is recomputed with d = w/s_min + o_max on non-zero nodes.
pub fn related_bounds(dag: &Dag, topo: &[u32], w: &[f64], sl: &[Slot]) -> (f64, f64) {
    let ssum: f64 = sl.iter().map(|s| s.speed).sum();
    let smax = sl.iter().map(|s| s.speed).fold(0.0, f64::max);
    let smin = sl.iter().map(|s| s.speed).fold(f64::INFINITY, f64::min);
    let omax = sl.iter().map(|s| s.overhead).fold(0.0, f64::max);
    let t1 = work(w);
    let (tinf, _) = critical_path(dag, topo, w);
    let lo = (t1 / ssum).max(tinf / smax);
    let d: Vec<f64> = w.iter().map(|&x| if x > 0.0 { x / smin + omax } else { 0.0 }).collect();
    let (dinf, _) = critical_path(dag, topo, &d);
    (lo, work(&d) / sl.len() as f64 + dinf)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Prio {
    /// Ready-time order (approximates siso's ready queue).
    Fifo,
    /// Largest bottom level first (HLFET).
    CriticalPath,
}

#[derive(PartialEq)]
struct Key(f64, u64, u32);
impl Eq for Key {}
impl PartialOrd for Key {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Key {
    fn cmp(&self, o: &Self) -> Ordering {
        self.0.total_cmp(&o.0).then(o.1.cmp(&self.1)).then(o.2.cmp(&self.2))
    }
}

/// Greedy list scheduling simulation (never leaves a slot idle while a task
/// is ready; free slots are taken fastest first). Zero-weight nodes (phony,
/// already done) complete instantly without a slot. Returns finish times.
pub fn list_schedule(dag: &Dag, topo: &[u32], w: &[f64], sl: &[Slot], prio: Prio) -> Vec<f64> {
    let n = dag.len();
    let bl = if prio == Prio::CriticalPath { bottom_levels(dag, topo, w) } else { Vec::new() };
    let mut indeg = dag.npred.clone();
    let mut finish = vec![0.0f64; n];
    let mut ready_at = vec![0.0f64; n];
    let mut ready: BinaryHeap<Key> = BinaryHeap::new();
    let mut seq = 0u64;
    let mut order: Vec<usize> = (0..sl.len()).collect();
    order.sort_by(|&a, &b| sl[b].speed.total_cmp(&sl[a].speed));
    let mut free: Vec<usize> = order.iter().rev().copied().collect(); // pop() = fastest
    let mut events: BinaryHeap<std::cmp::Reverse<Key>> = BinaryHeap::new();
    let mut now = 0.0f64;
    let mut stack: Vec<u32> = (0..n as u32).filter(|&v| indeg[v as usize] == 0).collect();

    let release = |v: u32, t: f64, ready: &mut BinaryHeap<Key>, seq: &mut u64| {
        let k = if prio == Prio::CriticalPath { bl[v as usize] } else { -t };
        *seq += 1;
        ready.push(Key(k, *seq, v));
    };
    loop {
        // Instant-complete zero-weight nodes, propagating readiness.
        while let Some(v) = stack.pop() {
            let vu = v as usize;
            if w[vu] == 0.0 {
                finish[vu] = ready_at[vu];
                for &x in &dag.succ[vu] {
                    let xu = x as usize;
                    ready_at[xu] = ready_at[xu].max(finish[vu]);
                    indeg[xu] -= 1;
                    if indeg[xu] == 0 {
                        stack.push(x);
                    }
                }
            } else {
                release(v, ready_at[vu], &mut ready, &mut seq);
            }
        }
        while !free.is_empty() && !ready.is_empty() {
            let Key(_, _, v) = ready.pop().unwrap();
            let s = free.pop().unwrap();
            let d = w[v as usize] / sl[s].speed + sl[s].overhead;
            events.push(std::cmp::Reverse(Key(now + d, s as u64, v)));
        }
        let Some(std::cmp::Reverse(Key(t, s, v))) = events.pop() else { break };
        now = t;
        let vu = v as usize;
        finish[vu] = t;
        // Return slot keeping `free` sorted slowest..fastest.
        let s = s as usize;
        let pos = free.partition_point(|&f| sl[f].speed < sl[s].speed);
        free.insert(pos, s);
        for &x in &dag.succ[vu] {
            let xu = x as usize;
            ready_at[xu] = ready_at[xu].max(t);
            indeg[xu] -= 1;
            if indeg[xu] == 0 {
                stack.push(x);
            }
        }
    }
    finish
}

pub fn makespan(f: &[f64]) -> f64 {
    f.iter().copied().fold(0.0, f64::max)
}

// ---------- statistics ----------

/// SplitMix64 (deterministic, seedable).
pub struct Rng(u64);
impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    pub fn below(&mut self, n: usize) -> usize {
        ((self.next_u64() as u128 * n as u128) >> 64) as usize
    }
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// Linear-interpolated quantile (type 7) of an unsorted sample.
pub fn quantile(xs: &[f64], q: f64) -> f64 {
    let mut v = xs.to_vec();
    v.sort_by(f64::total_cmp);
    quantile_sorted(&v, q)
}
pub fn quantile_sorted(v: &[f64], q: f64) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    let h = (v.len() - 1) as f64 * q;
    let (lo, hi) = (h.floor() as usize, h.ceil() as usize);
    v[lo] + (h - lo as f64) * (v[hi] - v[lo])
}
pub fn mean(xs: &[f64]) -> f64 {
    xs.iter().sum::<f64>() / xs.len() as f64
}

/// Wilson score interval for k successes out of n (z = 1.96 for 95 %).
pub fn wilson(k: u64, n: u64, z: f64) -> (f64, f64) {
    let (k, n) = (k as f64, n as f64);
    let p = k / n;
    let z2 = z * z;
    let c = (p + z2 / (2.0 * n)) / (1.0 + z2 / n);
    let h = z / (1.0 + z2 / n) * (p * (1.0 - p) / n + z2 / (4.0 * n * n)).sqrt();
    ((c - h).max(0.0), (c + h).min(1.0))
}

/// Moving-block bootstrap CI of the mean of an autocorrelated series.
pub fn block_bootstrap_mean_ci(x: &[f64], block: usize, b: usize, rng: &mut Rng) -> (f64, f64) {
    let n = x.len();
    let block = block.clamp(1, n);
    let mut means = Vec::with_capacity(b);
    for _ in 0..b {
        let mut s = 0.0;
        let mut m = 0;
        while m < n {
            let start = rng.below(n - block + 1);
            for &v in x[start..start + block].iter().take(n - m) {
                s += v;
                m += 1;
            }
        }
        means.push(s / n as f64);
    }
    means.sort_by(f64::total_cmp);
    (quantile_sorted(&means, 0.025), quantile_sorted(&means, 0.975))
}

/// Max and mean absolute difference between two completion-fraction curves
/// sampled on the same grid.
pub fn curve_error(a: &[f64], b: &[f64]) -> (f64, f64) {
    let d: Vec<f64> = a.iter().zip(b).map(|(x, y)| (x - y).abs()).collect();
    (d.iter().copied().fold(0.0, f64::max), mean(&d))
}

/// Fraction of `times` <= t for each t in grid.
pub fn completion_curve(times: &[f64], grid: &[f64]) -> Vec<f64> {
    let mut v = times.to_vec();
    v.sort_by(f64::total_cmp);
    grid.iter().map(|&t| v.partition_point(|&x| x <= t) as f64 / v.len() as f64).collect()
}

/// Work-weighted completion: sum of weights of tasks finished by t / total.
pub fn weighted_completion_curve(times: &[f64], w: &[f64], grid: &[f64]) -> Vec<f64> {
    let mut v: Vec<(f64, f64)> = times.iter().copied().zip(w.iter().copied()).collect();
    v.sort_by(|a, b| a.0.total_cmp(&b.0));
    let tot: f64 = w.iter().sum();
    let mut cum = Vec::with_capacity(v.len());
    let mut s = 0.0;
    for &(_, x) in &v {
        s += x;
        cum.push(s);
    }
    grid.iter()
        .map(|&t| {
            let i = v.partition_point(|x| x.0 <= t);
            if i == 0 { 0.0 } else { cum[i - 1] / tot }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn weighted_curve() {
        let c = super::weighted_completion_curve(&[1.0, 2.0], &[1.0, 3.0], &[0.0, 1.0, 2.0]);
        assert_eq!(c, vec![0.0, 0.25, 1.0]);
    }

    use super::*;

    // a(2) -> b(3), a -> c(5), b -> d(1), c -> d. T1 = 11, Tinf = 8 (a,c,d).
    fn diamond() -> (Dag, Vec<f64>) {
        let mut g = Dag::new(4);
        g.add_edge(0, 1);
        g.add_edge(0, 2);
        g.add_edge(1, 3);
        g.add_edge(2, 3);
        g.dedup();
        (g, vec![2.0, 3.0, 5.0, 1.0])
    }

    #[test]
    fn diamond_work_span_and_bounds() {
        let (g, w) = diamond();
        let t = g.topo().unwrap();
        assert_eq!(work(&w), 11.0);
        let (tinf, path) = critical_path(&g, &t, &w);
        assert_eq!(tinf, 8.0);
        assert_eq!(path, vec![0, 2, 3]);
        assert_eq!(brent_bounds(11.0, 8.0, 2), (8.0, 13.5));
        assert_eq!(brent_bounds(11.0, 8.0, 1), (11.0, 19.0));
        let bl = bottom_levels(&g, &t, &w);
        assert_eq!(bl, vec![8.0, 4.0, 6.0, 1.0]);
    }

    #[test]
    fn diamond_schedules() {
        let (g, w) = diamond();
        let t = g.topo().unwrap();
        let p2 = slots(&[(2, 1.0, 0.0)]);
        let p1 = slots(&[(1, 1.0, 0.0)]);
        let f = list_schedule(&g, &t, &w, &p2, Prio::CriticalPath);
        assert_eq!(f, vec![2.0, 5.0, 7.0, 8.0]);
        assert_eq!(makespan(&list_schedule(&g, &t, &w, &p1, Prio::Fifo)), 11.0);
        // one slot at speed 2 halves everything; overhead adds per task
        let fast = slots(&[(1, 2.0, 0.5)]);
        assert_eq!(makespan(&list_schedule(&g, &t, &w, &fast, Prio::Fifo)), 5.5 + 4.0 * 0.5);
        let (lo, hi) = related_bounds(&g, &t, &w, &p2);
        assert_eq!((lo, hi), (8.0, 13.5));
    }

    #[test]
    fn zero_weight_nodes_take_no_slot() {
        // phony hub: a(4) -> h(0) -> b(4), c(4) independent; p = 1 => 12
        let mut g = Dag::new(4);
        g.add_edge(0, 1);
        g.add_edge(1, 2);
        g.dedup();
        let w = vec![4.0, 0.0, 4.0, 4.0];
        let t = g.topo().unwrap();
        let f = list_schedule(&g, &t, &w, &slots(&[(1, 1.0, 0.0)]), Prio::CriticalPath);
        assert_eq!(makespan(&f), 12.0);
        assert_eq!(f[1], 4.0);
    }

    #[test]
    fn cycle_detected() {
        let mut g = Dag::new(2);
        g.add_edge(0, 1);
        g.add_edge(1, 0);
        g.dedup();
        assert!(g.topo().is_none());
    }

    #[test]
    fn random_dags_respect_bounds() {
        let mut r = Rng::new(42);
        for _ in 0..300 {
            let n = 2 + r.below(60);
            let mut g = Dag::new(n);
            for v in 1..n {
                for _ in 0..r.below(4) {
                    g.add_edge(r.below(v) as u32, v as u32);
                }
            }
            g.dedup();
            let w: Vec<f64> = (0..n).map(|_| if r.unit() < 0.1 { 0.0 } else { r.unit() * 10.0 }).collect();
            let t = g.topo().unwrap();
            let (tinf, _) = critical_path(&g, &t, &w);
            for p in [1usize, 2, 3, 7] {
                let sl = slots(&[(p, 1.0, 0.0)]);
                let (lo, hi) = brent_bounds(work(&w), tinf, p);
                for prio in [Prio::Fifo, Prio::CriticalPath] {
                    let m = makespan(&list_schedule(&g, &t, &w, &sl, prio));
                    assert!(m >= lo - 1e-9 && m <= hi + 1e-9, "p={p} m={m} lo={lo} hi={hi}");
                }
                // heterogeneous slots with overhead
                let sl = slots(&[(p, 1.0, 0.0), (2, 0.5, 0.3), (1, 1.7, 0.1)]);
                let (lo, hi) = related_bounds(&g, &t, &w, &sl);
                let m = makespan(&list_schedule(&g, &t, &w, &sl, Prio::CriticalPath));
                assert!(m >= lo - 1e-9 && m <= hi + 1e-9, "related m={m} lo={lo} hi={hi}");
            }
            // DP equals brute-force longest path (n small: relax n times)
            let mut f = w.clone();
            for _ in 0..n {
                for u in 0..n {
                    for &v in &g.succ[u] {
                        f[v as usize] = f[v as usize].max(f[u] + w[v as usize]);
                    }
                }
            }
            assert!((f.iter().copied().fold(0.0, f64::max) - tinf).abs() < 1e-9);
        }
    }

    #[test]
    fn wilson_known_values() {
        let (lo, hi) = wilson(3, 3, 1.96);
        assert!((lo - 0.43850).abs() < 1e-4, "{lo}");
        assert_eq!(hi, 1.0);
        let (lo, hi) = wilson(50, 100, 1.96);
        assert!((lo - 0.40383).abs() < 1e-4 && (hi - 0.59617).abs() < 1e-4);
    }

    #[test]
    fn quantile_and_curves() {
        assert_eq!(quantile(&[4.0, 1.0, 3.0, 2.0], 0.5), 2.5);
        let c = completion_curve(&[1.0, 2.0, 3.0, 4.0], &[0.0, 2.0, 4.0]);
        assert_eq!(c, vec![0.0, 0.5, 1.0]);
        assert_eq!(curve_error(&[0.0, 0.5], &[0.25, 0.5]), (0.25, 0.125));
    }
}
