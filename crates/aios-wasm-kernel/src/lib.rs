#![no_std]

#[cfg(not(test))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::unreachable()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        loop {}
    }
}

// Static scratch arena (64 KiB) for zero-dependency WASM host <-> guest exchange
static mut SCRATCH_HEAP: [u8; 65536] = [0u8; 65536];

#[unsafe(no_mangle)]
pub extern "C" fn aios_abi_version() -> u32 {
    0x0002_0100
}

#[unsafe(no_mangle)]
pub extern "C" fn aios_scratch_ptr() -> *mut u8 {
    core::ptr::addr_of_mut!(SCRATCH_HEAP) as *mut u8
}

#[unsafe(no_mangle)]
pub extern "C" fn aios_scratch_cap() -> usize {
    65536
}

/// Fast 64-bit FNV-1a content hash used for Nix-style store derivations and VFS deduplication.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn aios_fnv1a64(ptr: *const u8, len: usize) -> u64 {
    if ptr.is_null() && len > 0 {
        return 0;
    }
    let slice = unsafe { core::slice::from_raw_parts(ptr, len) };
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in slice {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Deterministic f32 cosine similarity kernel (runs in WASM32 and native C-ABI).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn aios_cosine_f32(a_ptr: *const f32, b_ptr: *const f32, len: usize) -> f32 {
    if a_ptr.is_null() || b_ptr.is_null() || len == 0 {
        return 0.0;
    }
    let a = unsafe { core::slice::from_raw_parts(a_ptr, len) };
    let b = unsafe { core::slice::from_raw_parts(b_ptr, len) };

    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;

    let mut i = 0usize;
    let chunks = len & !3;
    while i < chunks {
        let a0 = a[i];
        let a1 = a[i + 1];
        let a2 = a[i + 2];
        let a3 = a[i + 3];
        let b0 = b[i];
        let b1 = b[i + 1];
        let b2 = b[i + 2];
        let b3 = b[i + 3];

        dot += a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3;
        norm_a += a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;
        norm_b += b0 * b0 + b1 * b1 + b2 * b2 + b3 * b3;
        i += 4;
    }
    while i < len {
        let av = a[i];
        let bv = b[i];
        dot += av * bv;
        norm_a += av * av;
        norm_b += bv * bv;
        i += 1;
    }

    let prod = norm_a * norm_b;
    if prod <= 1e-20 {
        return 0.0;
    }
    dot * fast_inv_sqrt(prod)
}

/// RMSNorm forward pass: out[i] = (x[i] / sqrt(mean(x^2) + eps)) * weight[i]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn aios_rmsnorm_f32(
    x_ptr: *const f32,
    w_ptr: *const f32,
    out_ptr: *mut f32,
    len: usize,
    eps: f32,
) -> f32 {
    if x_ptr.is_null() || w_ptr.is_null() || out_ptr.is_null() || len == 0 {
        return 0.0;
    }
    let x = unsafe { core::slice::from_raw_parts(x_ptr, len) };
    let w = unsafe { core::slice::from_raw_parts(w_ptr, len) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, len) };

    let mut sum_sq = 0.0f32;
    for &v in x {
        sum_sq += v * v;
    }
    let mean_sq = sum_sq / (len as f32);
    let scale = fast_inv_sqrt(mean_sq + eps);
    for i in 0..len {
        out[i] = x[i] * scale * w[i];
    }
    scale
}

/// POSIX glob matcher (`*`, `?`) for zero-allocation VFS path filtering in WASM & native.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn aios_posix_glob_match(
    pat_ptr: *const u8,
    pat_len: usize,
    txt_ptr: *const u8,
    txt_len: usize,
) -> u32 {
    if pat_ptr.is_null() || txt_ptr.is_null() {
        return 0;
    }
    let pat = unsafe { core::slice::from_raw_parts(pat_ptr, pat_len) };
    let txt = unsafe { core::slice::from_raw_parts(txt_ptr, txt_len) };

    let mut px = 0usize;
    let mut tx = 0usize;
    let mut next_px = 0usize;
    let mut next_tx = 0usize;

    while px < pat.len() || tx < txt.len() {
        if px < pat.len() {
            let c = pat[px];
            if c == b'?' {
                if tx < txt.len() {
                    px += 1;
                    tx += 1;
                    continue;
                }
            } else if c == b'*' {
                next_px = px;
                next_tx = tx + 1;
                px += 1;
                continue;
            } else if tx < txt.len() && txt[tx] == c {
                px += 1;
                tx += 1;
                continue;
            }
        }
        if next_tx > 0 && next_tx <= txt.len() {
            px = next_px;
            tx = next_tx;
            continue;
        }
        return 0;
    }
    1
}

#[inline(always)]
fn fast_inv_sqrt(x: f32) -> f32 {
    let half = 0.5f32 * x;
    let mut i = x.to_bits();
    i = 0x5f37_5a86 - (i >> 1);
    let mut y = f32::from_bits(i);
    y = y * (1.5f32 - half * y * y);
    y = y * (1.5f32 - half * y * y);
    y
}
