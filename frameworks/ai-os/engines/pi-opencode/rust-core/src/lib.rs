//! Native Rust zero-copy file walker, FNV-1a/XXH-style workspace snapshotter,
//! line-oriented diff counter, and host safety boundary guard for `pi-opencode` via `bun:ffi`.

use std::ffi::{CStr, CString};
use std::fs;
use std::os::raw::c_char;
use std::path::{Path, PathBuf};

const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".jj",
    "node_modules",
    "target",
    "dist",
    ".turbo",
    ".next",
    "__pycache__",
];

const FORBIDDEN_HOST_PREFIXES_WIN: &[&str] = &[
    "c:\\windows",
    "c:/windows",
    "c:\\program files",
    "c:/program files",
    "c:\\program files (x86)",
    "c:/program files (x86)",
];

const FORBIDDEN_HOST_PREFIXES_UNIX: &[&str] = &[
    "/bin",
    "/sbin",
    "/usr/bin",
    "/usr/sbin",
    "/lib",
    "/etc",
    "/boot",
    "/proc",
    "/sys",
];

/// Fast deterministic 64-bit FNV-1a hash over bytes.
#[inline]
pub fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Validates that a candidate path never targets sacred OS directories (Torvalds userspace rule).
pub fn is_safe_workspace_path(candidate: &Path) -> bool {
    let raw = candidate.to_string_lossy().to_ascii_lowercase();
    for prefix in FORBIDDEN_HOST_PREFIXES_WIN {
        if raw == *prefix || raw.starts_with(&format!("{prefix}\\")) || raw.starts_with(&format!("{prefix}/")) {
            return false;
        }
    }
    for prefix in FORBIDDEN_HOST_PREFIXES_UNIX {
        if raw == *prefix || raw.starts_with(&format!("{prefix}/")) {
            return false;
        }
    }
    true
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceDigest {
    pub file_count: usize,
    pub total_bytes: u64,
    pub merkle_hash: u64,
}

fn walk_dir_recursive(root: &Path, dir: &Path, files: &mut Vec<(String, u64, u64)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            if IGNORED_DIRS.contains(&name) {
                continue;
            }
            walk_dir_recursive(root, &path, files);
        } else if meta.is_file() {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let len = meta.len();
            let content_hash = if len <= 4 * 1024 * 1024 {
                fs::read(&path).map(|b| fnv1a_64(&b)).unwrap_or(0)
            } else {
                len ^ fnv1a_64(rel.as_bytes())
            };
            files.push((rel, len, content_hash));
        }
    }
}

/// Computes a deterministic Merkle-like digest of a workspace directory (OpenCode snapshot style).
pub fn snapshot_workspace(root: &Path) -> WorkspaceDigest {
    let mut entries = Vec::new();
    walk_dir_recursive(root, root, &mut entries);
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut combined = Vec::with_capacity(entries.len() * 32);
    let mut total_bytes = 0u64;
    for (rel, len, h) in &entries {
        total_bytes = total_bytes.saturating_add(*len);
        combined.extend_from_slice(rel.as_bytes());
        combined.push(0);
        combined.extend_from_slice(&h.to_le_bytes());
    }

    WorkspaceDigest {
        file_count: entries.len(),
        total_bytes,
        merkle_hash: fnv1a_64(&combined),
    }
}

/// Computes added and removed line counts between two UTF-8 buffers.
pub fn diff_line_stats(before: &str, after: &str) -> (usize, usize) {
    let old_lines: Vec<&str> = before.lines().collect();
    let new_lines: Vec<&str> = after.lines().collect();

    // Fast prefix/suffix trim before LCS window
    let mut prefix = 0;
    while prefix < old_lines.len() && prefix < new_lines.len() && old_lines[prefix] == new_lines[prefix] {
        prefix += 1;
    }

    let mut old_end = old_lines.len();
    let mut new_end = new_lines.len();
    while old_end > prefix && new_end > prefix && old_lines[old_end - 1] == new_lines[new_end - 1] {
        old_end -= 1;
        new_end -= 1;
    }

    let old_mid = &old_lines[prefix..old_end];
    let new_mid = &new_lines[prefix..new_end];

    if old_mid.is_empty() {
        return (new_mid.len(), 0);
    }
    if new_mid.is_empty() {
        return (0, old_mid.len());
    }

    // Bounded O(N*M) LCS for compact diffs; fallback to set-based line count on huge files
    if old_mid.len().saturating_mul(new_mid.len()) <= 250_000 {
        let m = new_mid.len();
        let mut prev = vec![0usize; m + 1];
        let mut curr = vec![0usize; m + 1];
        for &o in old_mid {
            for (j, &n) in new_mid.iter().enumerate() {
                curr[j + 1] = if o == n {
                    prev[j] + 1
                } else {
                    prev[j + 1].max(curr[j])
                };
            }
            std::mem::swap(&mut prev, &mut curr);
            curr.fill(0);
        }
        let common = prev[m];
        (new_mid.len() - common, old_mid.len() - common)
    } else {
        (new_mid.len(), old_mid.len())
    }
}

/// Returns logical CPU thread count from Windows NT `GetSystemInfo` or `std::thread`.
pub fn logical_cpu_threads() -> u32 {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::SystemInformation::{GetSystemInfo, SYSTEM_INFO};
        let mut info: SYSTEM_INFO = std::mem::zeroed();
        GetSystemInfo(&mut info);
        if info.dwNumberOfProcessors > 0 {
            return info.dwNumberOfProcessors;
        }
    }
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(1)
}

// ============================================================================
// C ABI Exports for `bun:ffi`
// ============================================================================

#[unsafe(no_mangle)]
pub extern "C" fn pi_oc_cpu_threads() -> u32 {
    logical_cpu_threads()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pi_oc_is_safe_path(path_ptr: *const c_char) -> u32 {
    if path_ptr.is_null() {
        return 0;
    }
    let c_str = unsafe { CStr::from_ptr(path_ptr) };
    let Ok(s) = c_str.to_str() else {
        return 0;
    };
    u32::from(is_safe_workspace_path(&PathBuf::from(s)))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pi_oc_snapshot_json(root_ptr: *const c_char, out_buf: *mut u8, out_cap: usize) -> usize {
    if root_ptr.is_null() || out_buf.is_null() || out_cap == 0 {
        return 0;
    }
    let c_str = unsafe { CStr::from_ptr(root_ptr) };
    let Ok(root_str) = c_str.to_str() else {
        return 0;
    };
    let digest = snapshot_workspace(Path::new(root_str));
    let json = format!(
        "{{\"fileCount\":{},\"totalBytes\":{},\"merkleHash\":\"{:016x}\"}}",
        digest.file_count, digest.total_bytes, digest.merkle_hash
    );
    let bytes = json.as_bytes();
    let copy_len = bytes.len().min(out_cap.saturating_sub(1));
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_buf, copy_len);
        *out_buf.add(copy_len) = 0;
    }
    copy_len
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pi_oc_diff_stats(before_ptr: *const c_char, after_ptr: *const c_char) -> u64 {
    if before_ptr.is_null() || after_ptr.is_null() {
        return 0;
    }
    let b = unsafe { CStr::from_ptr(before_ptr) }.to_str().unwrap_or("");
    let a = unsafe { CStr::from_ptr(after_ptr) }.to_str().unwrap_or("");
    let (added, removed) = diff_line_stats(b, a);
    ((added as u64) << 32) | (removed as u64 & 0xFFFF_FFFF)
}

#[allow(dead_code)]
fn _keep_cstring_linked(s: &str) -> Option<CString> {
    CString::new(s).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sacred_userspace_guard_blocks_system32() {
        assert!(!is_safe_workspace_path(Path::new(r"C:\Windows\System32\cmd.exe")));
        assert!(!is_safe_workspace_path(Path::new("C:/Windows/System32")));
        assert!(!is_safe_workspace_path(Path::new("/usr/bin/bash")));
        assert!(is_safe_workspace_path(Path::new(r"C:\aphrody\packages\pi-opencode\src\cli.ts")));
    }

    #[test]
    fn test_diff_line_stats_accuracy() {
        let before = "fn a() {\n    let x = 1;\n    let y = 2;\n}\n";
        let after = "fn a() {\n    let x = 10;\n    let y = 2;\n    let z = 3;\n}\n";
        let (added, removed) = diff_line_stats(before, after);
        assert_eq!(added, 2);
        assert_eq!(removed, 1);
    }

    #[test]
    fn test_snapshot_workspace_deterministic() {
        let tmp = std::env::temp_dir().join(format!("pi_oc_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("sub")).unwrap();
        fs::write(tmp.join("a.txt"), b"linus").unwrap();
        fs::write(tmp.join("sub/b.txt"), b"jarred").unwrap();

        let d1 = snapshot_workspace(&tmp);
        let d2 = snapshot_workspace(&tmp);
        assert_eq!(d1.file_count, 2);
        assert_eq!(d1.total_bytes, 11);
        assert_eq!(d1.merkle_hash, d2.merkle_hash);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_cpu_threads_nonzero() {
        assert!(logical_cpu_threads() >= 1);
    }
}
