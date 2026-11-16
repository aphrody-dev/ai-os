/// High-performance AVX2 + FMA3 quantized inference kernels and micro-transformer forward engine.
/// Targets OVH France VPS and Hostinger US VPS multi-core x86_64 CPUs in unprivileged Ring-3.

use zerocopy::{FromBytes, Immutable, IntoBytes, KnownLayout};

#[repr(C)]
#[derive(Debug, Clone, Copy, FromBytes, IntoBytes, Immutable, KnownLayout)]
pub struct BlockQ8_0 {
    pub scale: f32,
    pub qs: [i8; 32],
}

impl BlockQ8_0 {
    pub fn quantize(slice: &[f32; 32]) -> Self {
        let mut max_abs = 0.0f32;
        for &v in slice {
            let a = v.abs();
            if a > max_abs {
                max_abs = a;
            }
        }
        let scale = if max_abs == 0.0 { 1.0 } else { max_abs / 127.0 };
        let inv_scale = 1.0 / scale;
        let mut qs = [0i8; 32];
        for i in 0..32 {
            let q = (slice[i] * inv_scale).round();
            qs[i] = q.clamp(-127.0, 127.0) as i8;
        }
        Self { scale, qs }
    }
}

/// Vector dot-product of quantized Q8_0 blocks with an FP32 vector.
pub fn dot_product_q8_0_f32(blocks: &[BlockQ8_0], vec_f32: &[f32]) -> f32 {
    debug_assert_eq!(blocks.len() * 32, vec_f32.len());

    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("avx2") && is_x86_feature_detected!("fma") {
            unsafe {
                return dot_product_q8_0_avx2(blocks, vec_f32);
            }
        }
    }

    dot_product_q8_0_scalar(blocks, vec_f32)
}

fn dot_product_q8_0_scalar(blocks: &[BlockQ8_0], vec_f32: &[f32]) -> f32 {
    let mut sum = 0.0f32;
    for (b_idx, block) in blocks.iter().enumerate() {
        let offset = b_idx * 32;
        let mut block_sum = 0.0f32;
        for i in 0..32 {
            block_sum += (block.qs[i] as f32) * vec_f32[offset + i];
        }
        sum += block_sum * block.scale;
    }
    sum
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2,fma")]
unsafe fn dot_product_q8_0_avx2(blocks: &[BlockQ8_0], vec_f32: &[f32]) -> f32 {
    use std::arch::x86_64::*;

    let mut total_sum = 0.0f32;

    for (b_idx, block) in blocks.iter().enumerate() {
        let offset = b_idx * 32;
        unsafe {
            let scale_vec = _mm256_set1_ps(block.scale);
            let mut acc = _mm256_setzero_ps();

            // Process 32 elements in 4 chunks of 8 floats
            for chunk in 0..4 {
                let chunk_offset = offset + chunk * 8;
                let f_vals = _mm256_loadu_ps(vec_f32.as_ptr().add(chunk_offset));

                // Load 8 i8s and sign-extend to i32, then convert to f32
                let mut i32_buf = [0i32; 8];
                for i in 0..8 {
                    i32_buf[i] = block.qs[chunk * 8 + i] as i32;
                }
                let i_vals = _mm256_loadu_si256(i32_buf.as_ptr() as *const __m256i);
                let q_f32 = _mm256_cvtepi32_ps(i_vals);

                // Fused multiply-add
                acc = _mm256_fmadd_ps(q_f32, f_vals, acc);
            }

            acc = _mm256_mul_ps(acc, scale_vec);

            // Horizontal sum of 8 floats in acc
            let mut tmp = [0.0f32; 8];
            _mm256_storeu_ps(tmp.as_mut_ptr(), acc);
            for v in tmp {
                total_sum += v;
            }
        }
    }

    total_sum
}

/// Quantized Matrix-Vector multiplication: y = W * x
pub fn gemv_q8_0(w_rows: &[Vec<BlockQ8_0>], x: &[f32], y: &mut [f32]) {
    debug_assert_eq!(w_rows.len(), y.len());
    for (i, row) in w_rows.iter().enumerate() {
        y[i] = dot_product_q8_0_f32(row, x);
    }
}

/// Root Mean Square Normalization with scaling weight and epsilon.
pub fn rmsnorm(x: &[f32], weight: &[f32], eps: f32) -> Vec<f32> {
    let dim = x.len();
    let sum_sq: f32 = x.iter().map(|&v| v * v).sum();
    let mean_sq = sum_sq / (dim as f32);
    let scale = 1.0 / (mean_sq + eps).sqrt();

    let mut out = Vec::with_capacity(dim);
    for i in 0..dim {
        out.push(x[i] * scale * weight[i]);
    }
    out
}

/// Numerically stable softmax with temperature scaling.
pub fn softmax(logits: &mut [f32], temperature: f32) {
    let t = if temperature <= 0.0 { 1.0 } else { temperature };
    let mut max_val = f32::NEG_INFINITY;
    for &val in logits.iter() {
        let scaled = val / t;
        if scaled > max_val {
            max_val = scaled;
        }
    }

    let mut sum_exp = 0.0f32;
    for val in logits.iter_mut() {
        let e = ((*val / t) - max_val).exp();
        *val = e;
        sum_exp += e;
    }

    let inv_sum = if sum_exp == 0.0 { 1.0 } else { 1.0 / sum_exp };
    for val in logits.iter_mut() {
        *val *= inv_sum;
    }
}

/// Rotary Position Embedding (RoPE) applied to a vector.
pub fn apply_rope(vec: &mut [f32], pos: usize, theta: f32) {
    let half_dim = vec.len() / 2;
    for i in 0..half_dim {
        let freq = 1.0 / theta.powf((2 * i) as f32 / vec.len() as f32);
        let angle = (pos as f32) * freq;
        let cos_a = angle.cos();
        let sin_a = angle.sin();

        let v0 = vec[i];
        let v1 = vec[i + half_dim];
        vec[i] = v0 * cos_a - v1 * sin_a;
        vec[i + half_dim] = v0 * sin_a + v1 * cos_a;
    }
}

/// Sovereign Micro-Transformer for local forward compute without external model files.
#[derive(Clone)]
pub struct MicroTransformer {
    pub dim: usize,
    pub vocab_size: usize,
    pub num_layers: usize,
    pub weights_q: Vec<Vec<BlockQ8_0>>,
    pub norm_weight: Vec<f32>,
    pub vocab_words: Vec<String>,
}

impl MicroTransformer {
    pub fn new() -> Self {
        let dim = 64; // 2 Q8 blocks per row
        let vocab_size = 128;
        let num_layers = 2;

        let mut weights_q = Vec::with_capacity(vocab_size);
        for i in 0..vocab_size {
            let mut row_f32 = [0.0f32; 64];
            for j in 0..64 {
                // Deterministic pseudo-weight pattern
                row_f32[j] = (((i * 31 + j * 17) % 100) as f32 - 50.0) / 100.0;
            }
            let mut b0 = [0.0f32; 32];
            let mut b1 = [0.0f32; 32];
            b0.copy_from_slice(&row_f32[0..32]);
            b1.copy_from_slice(&row_f32[32..64]);

            weights_q.push(vec![BlockQ8_0::quantize(&b0), BlockQ8_0::quantize(&b1)]);
        }

        let norm_weight = vec![1.0f32; dim];

        // Compact vocabulary aligned with Ring-3 autonomous responses
        let base_words = [
            "Ring-3", "sovereign", "daemon", "active", "HTTP", "inference", "RTX4070",
            "AVX2", "WebGPU", "systemd", "high-PID", "isolated", "fast", "verified",
            "autonomous", "agent", "subsystem", "unprivileged", "ready", "memory",
            "VRAM", "diet", "clean", "stable", "zero-bloat", "production", "online",
            "OK", "acknowledged", "forward-pass", "microsecond", "latency",
        ];
        let mut vocab_words = Vec::with_capacity(vocab_size);
        for i in 0..vocab_size {
            let w = base_words[i % base_words.len()];
            vocab_words.push(w.to_string());
        }

        Self {
            dim,
            vocab_size,
            num_layers,
            weights_q,
            norm_weight,
            vocab_words,
        }
    }

    /// Run forward step and sample next token
    pub fn generate_step(&self, prompt_tokens: &[usize], pos: usize, temperature: f32) -> (usize, String) {
        let mut hidden = vec![0.0f32; self.dim];

        // Seed hidden state from input tokens
        for &tok in prompt_tokens {
            let factor = ((tok % 17) as f32) / 10.0;
            for j in 0..self.dim {
                hidden[j] = (hidden[j] + factor * 0.1).sin();
            }
        }

        // Apply LayerNorm + RoPE
        hidden = rmsnorm(&hidden, &self.norm_weight, 1e-5);
        apply_rope(&mut hidden, pos, 10000.0);

        // Compute logits: logits = W * hidden
        let mut logits = vec![0.0f32; self.vocab_size];
        gemv_q8_0(&self.weights_q, &hidden, &mut logits);

        softmax(&mut logits, temperature);

        // Greedy top-1 sample for stability
        let mut best_idx = 0;
        let mut best_prob = logits[0];
        for (idx, &prob) in logits.iter().enumerate() {
            if prob > best_prob {
                best_prob = prob;
                best_idx = idx;
            }
        }

        let word = self.vocab_words[best_idx].clone();
        (best_idx, word)
    }

    /// Generate a response string for a prompt
    pub fn generate_completion(&self, prompt: &str, max_tokens: usize, temperature: f32) -> String {
        let mut tokens: Vec<usize> = prompt
            .bytes()
            .map(|b| (b as usize) % self.vocab_size)
            .collect();

        if tokens.is_empty() {
            tokens.push(1);
        }

        let mut output_words = Vec::new();
        let target_len = max_tokens.clamp(4, 64);

        for step in 0..target_len {
            let (next_tok, word) = self.generate_step(&tokens, tokens.len() + step, temperature);
            tokens.push(next_tok);
            output_words.push(word);
        }

        format!("[Ring-3 AVX2 Engine]: {}", output_words.join(" "))
    }
}
