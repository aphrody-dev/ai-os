//! Fleet-shared state on Valkey: stage-result cache (BLAKE3 -> payload), job streams with
//! consumer groups, blobs for hosts that lack a file, and pub/sub events. SQLite stays the local
//! source of truth; everything here is optional and degrades to "not available".

use super::resp::{Client, Url, Value};
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const NS: &str = "ay:1";
/// Stage results are immutable per (stage, version, hash): a month is only a garbage-collection bound.
pub const RESULT_TTL_S: u64 = 30 * 24 * 3600;
/// Blobs only bridge the gap until a worker has read the file.
pub const BLOB_TTL_S: u64 = 3600;
pub const MAX_BLOB: usize = 32 << 20;
pub const EVENTS: &str = "ay:1:evt";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Job {
    pub stage: String,
    pub ver: u32,
    pub path: String,
    pub hash: String,
    pub size: u64,
    pub kind: String,
    pub label: String,
    /// Host that enqueued the job (informational).
    pub host: String,
}

pub struct Shared {
    c: Client,
    url: Url,
    timeout: Duration,
}

pub fn res_key(stage: &str, ver: u32, hash: &str) -> String {
    format!("{NS}:res:{stage}:{ver}:{hash}")
}

pub fn jobs_key(role: &str) -> String {
    format!("{NS}:jobs:{role}")
}

/// 1-byte tag + payload: `0` raw, `z` zstd (only when it pays off).
pub fn encode(payload: &[u8]) -> Vec<u8> {
    if payload.len() > 256
        && let Ok(z) = zstd::bulk::compress(payload, 3)
        && z.len() + 8 < payload.len()
    {
        let mut out = Vec::with_capacity(z.len() + 1);
        out.push(b'z');
        out.extend_from_slice(&z);
        return out;
    }
    let mut out = Vec::with_capacity(payload.len() + 1);
    out.push(b'0');
    out.extend_from_slice(payload);
    out
}

pub fn decode(stored: &[u8]) -> Option<Vec<u8>> {
    match stored.split_first()? {
        (b'0', rest) => Some(rest.to_vec()),
        (b'z', rest) => zstd::bulk::decompress(rest, 256 << 20).ok(),
        _ => None,
    }
}

fn arg(s: &str) -> Vec<u8> {
    s.as_bytes().to_vec()
}

impl Shared {
    /// `AY_VALKEY_URL`, else `~/.config/ay/valkey.url`. None when unset or unreachable (cache off).
    pub fn from_env() -> Option<Self> {
        if std::env::var_os("AY_NO_SHARED").is_some() {
            return None;
        }
        let url = std::env::var("AY_VALKEY_URL").ok().or_else(|| {
            let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
            std::fs::read_to_string(std::path::Path::new(&home).join(".config/ay/valkey.url")).ok()
        })?;
        Self::connect(url.trim(), Duration::from_millis(400)).ok()
    }

    pub fn connect(url: &str, timeout: Duration) -> Result<Self, String> {
        let url = Url::parse(url)?;
        let c = Client::connect(&url, timeout)?;
        Ok(Self { c, url, timeout })
    }

    /// A second connection with the same credentials (pub/sub needs its own).
    pub fn fork(&self) -> Result<Self, String> {
        Ok(Self { c: Client::connect(&self.url, self.timeout)?, url: self.url.clone(), timeout: self.timeout })
    }

    pub fn host_label(&self) -> String {
        self.url.host.clone()
    }

    pub fn ping(&mut self) -> Result<(), String> {
        match self.c.cmd(&[b"PING"])? {
            Value::Bytes(b) if b == b"PONG" => Ok(()),
            v => Err(format!("PING: {v:?}")),
        }
    }

    /// MGET in one pipelined round trip; decoded payloads, `None` for misses.
    pub fn get_many(&mut self, keys: &[String]) -> Result<Vec<Option<Vec<u8>>>, String> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let cmds: Vec<Vec<Vec<u8>>> = keys
            .chunks(256)
            .map(|chunk| {
                let mut c = vec![arg("MGET")];
                c.extend(chunk.iter().map(|k| arg(k)));
                c
            })
            .collect();
        let mut out = Vec::with_capacity(keys.len());
        for reply in self.c.pipeline(&cmds)? {
            match reply {
                Value::Array(items) => {
                    out.extend(items.into_iter().map(|v| v.into_bytes().and_then(|b| decode(&b))));
                }
                Value::Err(e) => return Err(format!("MGET: {e}")),
                _ => return Err("MGET: unexpected reply".into()),
            }
        }
        Ok(out)
    }

    /// `SET key value EX ttl` for every item, pipelined.
    pub fn set_many(&mut self, items: &[(String, Vec<u8>)], ttl_s: u64) -> Result<(), String> {
        if items.is_empty() {
            return Ok(());
        }
        let ttl = ttl_s.to_string();
        for part in items.chunks(512) {
            let cmds: Vec<Vec<Vec<u8>>> = part
                .iter()
                .map(|(k, v)| vec![arg("SET"), arg(k), encode(v), arg("EX"), arg(&ttl)])
                .collect();
            for r in self.c.pipeline(&cmds)? {
                if let Value::Err(e) = r {
                    return Err(format!("SET: {e}"));
                }
            }
        }
        Ok(())
    }

    pub fn put_blob(&mut self, hash: &str, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > MAX_BLOB {
            return Err("blob too large".into());
        }
        let key = format!("{NS}:blob:{hash}");
        let ttl = BLOB_TTL_S.to_string();
        match self.c.cmd(&[b"SET", key.as_bytes(), &encode(bytes), b"EX", ttl.as_bytes(), b"NX"])? {
            Value::Err(e) => Err(e),
            _ => Ok(()),
        }
    }

    pub fn get_blob(&mut self, hash: &str) -> Result<Option<Vec<u8>>, String> {
        let key = format!("{NS}:blob:{hash}");
        Ok(self.c.cmd(&[b"GET", key.as_bytes()])?.into_bytes().and_then(|b| decode(&b)))
    }

    pub fn publish(&mut self, msg: &str) -> Result<(), String> {
        match self.c.cmd(&[b"PUBLISH", EVENTS.as_bytes(), msg.as_bytes()])? {
            Value::Err(e) => Err(e),
            _ => Ok(()),
        }
    }

    /// Create the consumer group of `role` (idempotent).
    pub fn ensure_group(&mut self, role: &str) -> Result<(), String> {
        let key = jobs_key(role);
        match self.c.cmd(&[b"XGROUP", b"CREATE", key.as_bytes(), b"workers", b"0", b"MKSTREAM"])? {
            Value::Err(e) if !e.starts_with("BUSYGROUP") => Err(e),
            _ => Ok(()),
        }
    }

    /// Queue `job` once per (stage, ver, hash) within `dedup_s`. Returns whether it was queued.
    pub fn enqueue(&mut self, role: &str, job: &Job, dedup_s: u64) -> Result<bool, String> {
        let dk = format!("{NS}:job:{}:{}:{}", job.stage, job.ver, job.hash);
        let ttl = dedup_s.to_string();
        if self.c.cmd(&[b"SET", dk.as_bytes(), b"1", b"NX", b"EX", ttl.as_bytes()])? == Value::Nil {
            return Ok(false);
        }
        let json = serde_json::to_string(job).map_err(|e| e.to_string())?;
        let key = jobs_key(role);
        match self.c.cmd(&[b"XADD", key.as_bytes(), b"MAXLEN", b"~", b"200000", b"*", b"j", json.as_bytes()])? {
            Value::Err(e) => Err(e),
            _ => Ok(true),
        }
    }

    pub fn queue_len(&mut self, role: &str) -> Result<i64, String> {
        let key = jobs_key(role);
        match self.c.cmd(&[b"XLEN", key.as_bytes()])? {
            Value::Int(n) => Ok(n),
            _ => Ok(0),
        }
    }

    fn parse_entries(v: Value) -> Vec<(String, Job)> {
        let mut out = Vec::new();
        for entry in v.into_array() {
            let mut it = entry.into_array().into_iter();
            let (Some(id), Some(fields)) = (it.next(), it.next()) else { continue };
            let Some(id) = id.as_str().map(str::to_string) else { continue };
            let f = fields.into_array();
            let json = f.chunks(2).find_map(|kv| match kv {
                [k, v] if k.as_str() == Some("j") => v.as_str().map(str::to_string),
                _ => None,
            });
            if let Some(job) = json.and_then(|j| serde_json::from_str::<Job>(&j).ok()) {
                out.push((id, job));
            }
        }
        out
    }

    /// Reclaim jobs idle for `idle_ms` (a dead worker), else block up to `block_ms` for new ones.
    pub fn claim(&mut self, role: &str, consumer: &str, count: usize, block_ms: u64, idle_ms: u64) -> Result<Vec<(String, Job)>, String> {
        let key = jobs_key(role);
        let cnt = count.to_string();
        let idle = idle_ms.to_string();
        let reply = self.c.cmd(&[
            b"XAUTOCLAIM", key.as_bytes(), b"workers", consumer.as_bytes(), idle.as_bytes(), b"0-0", b"COUNT", cnt.as_bytes(),
        ])?;
        if let Value::Array(mut parts) = reply
            && parts.len() >= 2
        {
            let claimed = Self::parse_entries(parts.swap_remove(1));
            if !claimed.is_empty() {
                return Ok(claimed);
            }
        }
        let block = block_ms.to_string();
        self.c.set_read_timeout(Some(Duration::from_millis(block_ms) + self.timeout));
        let reply = self.c.cmd(&[
            b"XREADGROUP", b"GROUP", b"workers", consumer.as_bytes(), b"COUNT", cnt.as_bytes(), b"BLOCK", block.as_bytes(),
            b"STREAMS", key.as_bytes(), b">",
        ]);
        self.c.set_read_timeout(Some(self.timeout));
        let reply = reply?;
        let mut out = Vec::new();
        for stream in reply.into_array() {
            let mut it = stream.into_array().into_iter();
            let _name = it.next();
            if let Some(entries) = it.next() {
                out.extend(Self::parse_entries(entries));
            }
        }
        Ok(out)
    }

    pub fn ack(&mut self, role: &str, id: &str) -> Result<(), String> {
        let key = jobs_key(role);
        self.c.pipeline(&[
            vec![arg("XACK"), arg(&key), arg("workers"), arg(id)],
            vec![arg("XDEL"), arg(&key), arg(id)],
        ])?;
        Ok(())
    }

    /// Block until one event on [`EVENTS`] (or `timeout`); None on timeout.
    pub fn subscribe(mut self) -> Result<Subscriber, String> {
        match self.c.cmd(&[b"SUBSCRIBE", EVENTS.as_bytes()])? {
            Value::Err(e) => Err(e),
            _ => Ok(Subscriber { c: self.c }),
        }
    }

    /// `INFO`-free health line for `ay index status`.
    pub fn dbsize(&mut self) -> Result<i64, String> {
        match self.c.cmd(&[b"DBSIZE"])? {
            Value::Int(n) => Ok(n),
            _ => Ok(0),
        }
    }
}

pub struct Subscriber {
    c: Client,
}

impl Subscriber {
    pub fn next(&mut self, timeout: Duration) -> Option<String> {
        self.c.set_read_timeout(Some(timeout));
        match self.c.read_value() {
            Ok(Value::Array(a)) if a.len() == 3 && a[0].as_str() == Some("message") => a[2].as_str().map(str::to_string),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_codec_round_trips_and_compresses_repetitive_data() {
        let small = b"abc".to_vec();
        assert_eq!(decode(&encode(&small)).unwrap(), small);
        let big = b"fn main() {}\n".repeat(500);
        let enc = encode(&big);
        assert_eq!(enc[0], b'z');
        assert!(enc.len() < big.len() / 4);
        assert_eq!(decode(&enc).unwrap(), big);
        assert!(decode(b"?junk").is_none());
    }

    #[test]
    fn keys_are_versioned_and_namespaced() {
        assert_eq!(res_key("tree-sitter", 2, "ab"), "ay:1:res:tree-sitter:2:ab");
        assert_eq!(jobs_key("heavy"), "ay:1:jobs:heavy");
    }

    /// Needs a live server: `AY_TEST_VALKEY=valkey://:pw@host:6379 cargo test -p aphrody-core --features pipeline`.
    #[test]
    fn live_cache_queue_and_events() {
        let Ok(url) = std::env::var("AY_TEST_VALKEY") else { return };
        let mut s = Shared::connect(&url, Duration::from_secs(2)).unwrap();
        s.ping().unwrap();
        let k = res_key("test", 1, &format!("{:x}", std::process::id()));
        let big = b"x".repeat(4096);
        s.set_many(&[(k.clone(), big.clone())], 30).unwrap();
        let got = s.get_many(&[k, "ay:1:missing".into()]).unwrap();
        assert_eq!(got[0].as_deref(), Some(big.as_slice()));
        assert!(got[1].is_none());
        let role = format!("test{}", std::process::id());
        s.ensure_group(&role).unwrap();
        let job = Job {
            stage: "t".into(), ver: 1, path: "a".into(), hash: format!("h{role}"), size: 1,
            kind: "binary".into(), label: "pe".into(), host: "x".into(),
        };
        assert!(s.enqueue(&role, &job, 30).unwrap());
        assert!(!s.enqueue(&role, &job, 30).unwrap(), "deduplicated");
        let claimed = s.claim(&role, "c1", 4, 200, 60_000).unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].1, job);
        s.ack(&role, &claimed[0].0).unwrap();
        assert_eq!(s.queue_len(&role).unwrap(), 0);
    }
}
