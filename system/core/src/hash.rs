//! Content hashing (BLAKE3). Single implementation shared by the index, the C ABI and bun:ffi.

use std::path::Path;

/// BLAKE3 of a byte slice, lowercase hex (64 chars).
pub fn blake3_hex(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// BLAKE3 of a file (memory-mapped, multi-threaded for large inputs).
pub fn blake3_file_hex(path: &Path) -> std::io::Result<String> {
    let mut hasher = blake3::Hasher::new();
    hasher.update_mmap_rayon(path)?;
    Ok(hasher.finalize().to_hex().to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn empty_input_matches_reference_vector() {
        assert_eq!(
            super::blake3_hex(b""),
            "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
        );
    }
}
