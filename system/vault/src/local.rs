// SPDX-License-Identifier: Apache-2.0
//! Local layer, same files as the TS store (`system/env-kit/vault/src/store.ts`).

use crate::{valid_name, Error, Result};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Dpapi,
    SystemdCreds,
    SystemdCredsUser,
}

#[derive(Debug, Clone)]
pub struct StoreInfo {
    pub backend: Backend,
    pub dir: PathBuf,
    pub legacy: Vec<PathBuf>,
}

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

pub fn vault_root() -> PathBuf {
    if let Some(d) = env("APHRODY_VAULT_DIR") {
        return d.into();
    }
    if cfg!(windows) {
        return Path::new(&env("SRC_ROOT").unwrap_or_else(|| env!("SRC_ROOT").into())).join("var").join("secrets");
    }
    let data = env("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".local").join("share"));
    data.join("aphrody").join("vault")
}

fn home() -> PathBuf {
    env("HOME").or_else(|| env("USERPROFILE")).map(PathBuf::from).unwrap_or_default()
}

fn is_root() -> bool {
    #[cfg(unix)]
    {
        std::fs::metadata("/proc/self").map(|m| std::os::unix::fs::MetadataExt::uid(&m) == 0).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        false
    }
}

pub fn store_info() -> StoreInfo {
    let over = env("ENV_KIT_SECRET_DIR").map(PathBuf::from);
    if cfg!(windows) {
        let legacy = env("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home().join("AppData").join("Local"));
        return StoreInfo {
            backend: Backend::Dpapi,
            legacy: if over.is_some() { vec![] } else { vec![legacy.join("aphrody").join("secrets")] },
            dir: over.unwrap_or_else(|| vault_root().join("local")),
        };
    }
    if is_root() {
        return StoreInfo { backend: Backend::SystemdCreds, dir: over.unwrap_or_else(|| "/etc/credstore.encrypted".into()), legacy: vec![] };
    }
    let cfg = env("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".config"));
    StoreInfo { backend: Backend::SystemdCredsUser, dir: over.unwrap_or_else(|| cfg.join("credstore.encrypted")), legacy: vec![] }
}

/// DPAPI file format v2: b"AYD2" + blob with entropy bound to the name. v1 = raw blob, fixed entropy.
pub const DPAPI_V2: &[u8; 4] = b"AYD2";
pub fn entropy_v2(name: &str) -> Vec<u8> {
    format!("aphrody/vault/dpapi/v2|{name}").into_bytes()
}

fn file_name(info: &StoreInfo, name: &str) -> String {
    if info.backend == Backend::Dpapi { format!("{name}.dpapi") } else { name.to_string() }
}

async fn locate(info: &StoreInfo, name: &str) -> Option<PathBuf> {
    let mut best: Option<(PathBuf, std::time::SystemTime)> = None;
    for d in std::iter::once(&info.dir).chain(info.legacy.iter()) {
        let p = d.join(file_name(info, name));
        if let Ok(m) = tokio::fs::metadata(&p).await {
            let t = m.modified().unwrap_or(std::time::UNIX_EPOCH);
            if best.as_ref().is_none_or(|(_, b)| t > *b) {
                best = Some((p, t));
            }
        }
    }
    best.map(|(p, _)| p)
}

async fn creds(user: bool, args: &[&str], input: Option<&[u8]>) -> Result<Zeroizing<Vec<u8>>> {
    use tokio::io::AsyncWriteExt;
    let mut cmd = tokio::process::Command::new("systemd-creds");
    if user {
        cmd.arg("--user");
    }
    cmd.args(args).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn()?;
    let mut stdin = child.stdin.take();
    if let (Some(s), Some(i)) = (stdin.as_mut(), input) {
        s.write_all(i).await?;
    }
    drop(stdin);
    let out = child.wait_with_output().await?;
    if !out.status.success() {
        return Err(Error::Os(format!("systemd-creds {}: {}", args[0], String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(Zeroizing::new(out.stdout))
}

pub async fn set_secret(name: &str, value: &[u8]) -> Result<()> {
    if !valid_name(name) {
        return Err(Error::InvalidName(name.into()));
    }
    if value.is_empty() {
        return Err(Error::Crypto("empty value"));
    }
    let info = store_info();
    tokio::fs::create_dir_all(&info.dir).await?;
    let file = info.dir.join(file_name(&info, name));
    match info.backend {
        #[cfg(windows)]
        Backend::Dpapi => {
            let v = Zeroizing::new(value.to_vec());
            let e = entropy_v2(name);
            let mut blob = DPAPI_V2.to_vec();
            blob.extend(tokio::task::spawn_blocking(move || crate::win::dpapi_protect(&v, &e)).await.map_err(|_| Error::Os("join".into()))??);
            let tmp = file.with_extension(format!("dpapi.{}.tmp", std::process::id()));
            tokio::fs::write(&tmp, blob).await?;
            tokio::fs::rename(&tmp, &file).await?;
            Ok(())
        }
        #[cfg(not(windows))]
        Backend::Dpapi => Err(Error::Os("DPAPI on Windows only".into())),
        b => {
            let f = file.to_string_lossy().into_owned();
            creds(b == Backend::SystemdCredsUser, &["encrypt", &format!("--name={name}"), "-", &f], Some(value)).await.map(|_| ())
        }
    }
}

pub async fn get_secret(name: &str) -> Result<Zeroizing<Vec<u8>>> {
    if !valid_name(name) {
        return Err(Error::InvalidName(name.into()));
    }
    let info = store_info();
    let file = locate(&info, name).await.ok_or_else(|| Error::NotFound(name.into()))?;
    match info.backend {
        #[cfg(windows)]
        Backend::Dpapi => {
            let raw = tokio::fs::read(&file).await?;
            // `vault migrate-dpapi` marker: once every blob is v2, v1 is refused (same rule as TS).
            if !raw.starts_with(DPAPI_V2) && tokio::fs::metadata(info.dir.join(".dpapi-v2-only")).await.is_ok() {
                return Err(Error::Crypto("DPAPI v1 refused (vault is v2-only)"));
            }
            let e = entropy_v2(name);
            tokio::task::spawn_blocking(move || match raw.strip_prefix(DPAPI_V2.as_slice()) {
                Some(b) => crate::win::dpapi_unprotect(b, &e),
                None => crate::win::dpapi_unprotect(&raw, crate::win::ENTROPY),
            })
            .await
            .map_err(|_| Error::Os("join".into()))?
        }
        #[cfg(not(windows))]
        Backend::Dpapi => Err(Error::Os("DPAPI on Windows only".into())),
        b => {
            let f = file.to_string_lossy().into_owned();
            creds(b == Backend::SystemdCredsUser, &["decrypt", &format!("--name={name}"), &f, "-"], None).await
        }
    }
}

pub async fn has_secret(name: &str) -> bool {
    valid_name(name) && locate(&store_info(), name).await.is_some()
}

pub async fn list_secrets() -> Result<Vec<String>> {
    let info = store_info();
    let mut names = std::collections::BTreeSet::new();
    for d in std::iter::once(&info.dir).chain(info.legacy.iter()) {
        let Ok(mut rd) = tokio::fs::read_dir(d).await else { continue };
        while let Some(e) = rd.next_entry().await? {
            let f = e.file_name().to_string_lossy().into_owned();
            let n = if info.backend == Backend::Dpapi {
                match f.strip_suffix(".dpapi") {
                    Some(n) => n.to_string(),
                    None => continue,
                }
            } else {
                f
            };
            if valid_name(&n) && !n.starts_with('.') {
                names.insert(n);
            }
        }
    }
    Ok(names.into_iter().collect())
}
