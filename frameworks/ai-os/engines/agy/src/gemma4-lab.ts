import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  federateChatCompletion,
  formatGemma4Prompt,
  type Gemma4Turn,
  writeFileSafeUserspace,
} from "../../../src/index.ts";

export interface Gemma4ModelSpec {
  id: string;
  displayName: string;
  paramsBillions: number;
  quantization: string;
  vramRequiredMb: number;
  contextLength: number;
  multimodalVisionAudio: boolean;
  thinkingCapable: boolean;
  uncensoredVariant: boolean;
  huggingFaceRepo: string;
  recommendedUse: string;
}

export const GEMMA_4_MODEL_CATALOG: readonly Gemma4ModelSpec[] = [
  {
    id: "gemma-4-e2b-it-q8",
    displayName: "Gemma 4 E2B Instruct (Any-to-Any Multimodal Edge)",
    paramsBillions: 2.6,
    quantization: "Q8_0",
    vramRequiredMb: 2950,
    contextLength: 128_000,
    multimodalVisionAudio: true,
    thinkingCapable: true,
    uncensoredVariant: false,
    huggingFaceRepo: "google/gemma-4-E2B-it-GGUF",
    recommendedUse:
      "Sub-10ms voice/vision computer-use & mobile/desktop background daemon",
  },
  {
    id: "gemma-4-e4b-it-q6k",
    displayName: "Gemma 4 E4B Instruct (Multimodal Vision + Audio + Code)",
    paramsBillions: 4.5,
    quantization: "Q6_K",
    vramRequiredMb: 4400,
    contextLength: 128_000,
    multimodalVisionAudio: true,
    thinkingCapable: true,
    uncensoredVariant: false,
    huggingFaceRepo: "google/gemma-4-E4B-it-GGUF",
    recommendedUse:
      "Balanced daily local multimodal assistant leaving >7GB VRAM free on RTX 4070",
  },
  {
    id: "gemma-4-12b-heretic-q4km",
    displayName:
      "Gemma 4 12B Instruct + Heretic Abliterated (RTX 4070 Sweet Spot)",
    paramsBillions: 12.2,
    quantization: "Q4_K_M",
    vramRequiredMb: 8150,
    contextLength: 128_000,
    multimodalVisionAudio: true,
    thinkingCapable: true,
    uncensoredVariant: true,
    huggingFaceRepo: "aphrody-dev/gemma-4-12B-heretic-GGUF",
    recommendedUse:
      "Primary 100% GPU-resident reasoning, coding & NotebookLM synthesis on RTX 4070 12GB",
  },
  {
    id: "gemma-4-26b-a4b-moe-q4km",
    displayName: "Gemma 4 26B-A4B MoE (4B Active Parameters)",
    paramsBillions: 26.0,
    quantization: "IQ4_XS",
    vramRequiredMb: 11_400,
    contextLength: 256_000,
    multimodalVisionAudio: true,
    thinkingCapable: true,
    uncensoredVariant: false,
    huggingFaceRepo: "google/gemma-4-26B-A4B-it-GGUF",
    recommendedUse:
      "High-speed Mixture-of-Experts (>95 tok/s) fitting tightly in 12GB VRAM with KV q8_0",
  },
  {
    id: "gemma-4-31b-dense-iq2m",
    displayName: "Gemma 4 31B Dense Reasoning (Hybrid CUDA sm_89 + AVX2 DDR5)",
    paramsBillions: 31.0,
    quantization: "IQ3_XXS",
    vramRequiredMb: 13_800,
    contextLength: 256_000,
    multimodalVisionAudio: true,
    thinkingCapable: true,
    uncensoredVariant: true,
    huggingFaceRepo: "google/gemma-4-31B-it-GGUF",
    recommendedUse:
      "Frontier open-weights DeepMind reasoning with partial CPU+GPU split offload",
  },
];

export interface VramFitAssessment {
  model: Gemma4ModelSpec;
  availableVramMb: number;
  kvCacheOverheadMb: number;
  totalRequiredMb: number;
  fits100PctGpu: boolean;
  recommendedGpuLayers: number;
  llamaServerFlags: string[];
}

export function selectOptimalGemma4Model(options?: {
  availableVramMb?: number;
  requireUncensored?: boolean;
  requireMultimodal?: boolean;
  contextTokens?: number;
}): VramFitAssessment {
  const availableVramMb = options?.availableVramMb ?? 11_500; // RTX 4070 12GB minus Windows DWM diet
  const contextTokens = options?.contextTokens ?? 16_384;
  const kvCacheOverheadMb = Math.round((contextTokens / 16_384) * 650);

  const candidates = GEMMA_4_MODEL_CATALOG.filter((m) => {
    if (options?.requireUncensored && !m.uncensoredVariant) return false;
    if (options?.requireMultimodal && !m.multimodalVisionAudio) return false;
    return true;
  });

  // Pick largest model that fits 100% in GPU VRAM, else fallback to smallest
  const fitting = candidates
    .filter((m) => m.vramRequiredMb + kvCacheOverheadMb <= availableVramMb)
    .sort((a, b) => b.paramsBillions - a.paramsBillions);

  const chosen = fitting[0] ?? candidates[0] ?? GEMMA_4_MODEL_CATALOG[2]!;
  const totalRequiredMb = chosen.vramRequiredMb + kvCacheOverheadMb;
  const fits100PctGpu = totalRequiredMb <= availableVramMb;
  const totalLayers = chosen.paramsBillions > 20 ? 60 : 42;
  const recommendedGpuLayers = fits100PctGpu
    ? 99
    : Math.max(
        16,
        Math.floor((availableVramMb / totalRequiredMb) * totalLayers),
      );

  const llamaServerFlags = [
    "-ngl",
    String(recommendedGpuLayers),
    "-c",
    String(contextTokens),
    "--flash-attn",
    "on",
    "--cache-type-k",
    "q8_0",
    "--cache-type-v",
    "q8_0",
    ...(chosen.multimodalVisionAudio
      ? ["--mmproj", "mmproj-gemma4-f16.gguf"]
      : []),
  ];

  return {
    model: chosen,
    availableVramMb,
    kvCacheOverheadMb,
    totalRequiredMb,
    fits100PctGpu,
    recommendedGpuLayers,
    llamaServerFlags,
  };
}

export function discoverLocalGgufModels(): Array<{
  name: string;
  path: string;
}> {
  const searchDirs = [
    "%USERPROFILE%/.cache/llama.cpp",
    "%USERPROFILE%/.lmstudio/models",
    "C:/aphrody/var/models",
  ];
  const found: Array<{ name: string; path: string }> = [];
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".gguf")) {
          found.push({
            name: entry.name,
            path: join(dir, entry.name).replace(/\\/g, "/"),
          });
        }
      }
    } catch {
      // ignore inaccessible dirs
    }
  }
  return found;
}

export type GemmaTrainingStyle = "jax-tunix" | "cuda-sm89" | "pytorch-heretic";

export function generateGemma4TrainingPipeline(
  style: GemmaTrainingStyle,
  options?: {
    modelId?: string;
    outDir?: string;
    loraRank?: number;
    learningRate?: number;
  },
): {
  style: GemmaTrainingStyle;
  modelId: string;
  filePath: string;
  runCommand: string;
  sourceCode: string;
} {
  const modelId = options?.modelId ?? "google/gemma-4-12b-it";
  const outDir = options?.outDir ?? "C:/aphrody/var/agy-gemma4-lab";
  const loraRank = options?.loraRank ?? 16;
  const lr = options?.learningRate ?? 2e-4;
  mkdirSync(outDir, { recursive: true });

  if (style === "jax-tunix") {
    const filePath = join(outDir, "train_gemma4_jax_tunix.py");
    const sourceCode = `# DeepMind Gemma 4 JAX + Flax NNX + Optax + Tunix LoRA/GRPO Pipeline
# Run with: uv run --with jax --with flax --with optax --with tunix python train_gemma4_jax_tunix.py
from __future__ import annotations
import jax
import jax.numpy as jnp
import optax

MODEL_ID = "${modelId}"
LORA_RANK = ${loraRank}
LEARNING_RATE = ${lr}

def rms_norm(x: jax.Array, scale: jax.Array, eps: float = 1e-6) -> jax.Array:
    variance = jnp.mean(jnp.square(x), axis=-1, keepdims=True)
    return x * jax.lax.rsqrt(variance + eps) * (1.0 + scale)

def lora_linear(x: jax.Array, w: jax.Array, lora_a: jax.Array, lora_b: jax.Array, alpha: float = 16.0) -> jax.Array:
    base = jnp.dot(x, w)
    delta = jnp.dot(jnp.dot(x, lora_a), lora_b) * (alpha / LORA_RANK)
    return base + delta

@jax.jit
def train_step(lora_params: dict, optimizer_state, batch_x: jax.Array, batch_y: jax.Array, base_w: jax.Array):
    tx = optax.adamw(learning_rate=LEARNING_RATE, weight_decay=0.01)
    def loss_fn(p):
        preds = lora_linear(batch_x, base_w, p["a"], p["b"])
        return jnp.mean(jnp.square(preds - batch_y))
    loss, grads = jax.value_and_grad(loss_fn)(lora_params)
    updates, next_opt = tx.update(grads, optimizer_state, lora_params)
    return optax.apply_updates(lora_params, updates), next_opt, loss

if __name__ == "__main__":
    key = jax.random.PRNGKey(42)
    d_in, d_out = 512, 512
    base_w = jax.random.normal(key, (d_in, d_out)) * 0.02
    params = {
        "a": jax.random.normal(key, (d_in, LORA_RANK)) * 0.01,
        "b": jnp.zeros((LORA_RANK, d_out)),
    }
    tx = optax.adamw(learning_rate=LEARNING_RATE, weight_decay=0.01)
    opt_state = tx.init(params)
    x = jax.random.normal(key, (8, d_in))
    y = jax.random.normal(key, (8, d_out))
    params, opt_state, loss = train_step(params, opt_state, x, y, base_w)
    print({"model": MODEL_ID, "backend": jax.default_backend(), "initial_loss": float(loss)})
`;
    writeFileSafeUserspace(filePath, sourceCode);
    return {
      style,
      modelId,
      filePath: filePath.replace(/\\/g, "/"),
      runCommand: `uv run --with jax --with optax python "${filePath.replace(/\\/g, "/")}"`,
      sourceCode,
    };
  }

  if (style === "cuda-sm89") {
    const filePath = join(outDir, "gemma4_rmsnorm_geglu_sm89.cu");
    const sourceCode = `// Google DeepMind Gemma 4 Fused RMSNorm + GeGLU Kernel for NVIDIA Ada sm_89 (CUDA 13.4)
// Compile: nvcc -arch=sm_89 -O3 --use_fast_math gemma4_rmsnorm_geglu_sm89.cu -o gemma4_sm89.exe
#include <cuda_runtime.h>
#include <cuda_bf16.h>
#include <math.h>
#include <stdio.h>

__device__ __forceinline__ float gelu_tanh(float x) {
    const float k0 = 0.7978845608f;
    const float k1 = 0.044715f;
    return 0.5f * x * (1.0f + tanhf(k0 * (x + k1 * x * x * x)));
}

extern "C" __global__ void gemma4_fused_rmsnorm_geglu_sm89(
    const float* __restrict__ input,
    const float* __restrict__ norm_scale,
    const float* __restrict__ gate_up,
    float* __restrict__ out,
    int hidden_dim
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= hidden_dim) return;

    float sum_sq = 0.0f;
    for (int i = 0; i < hidden_dim; ++i) {
        float v = input[i];
        sum_sq = fmaf(v, v, sum_sq);
    }
    float inv_rms = rsqrtf(sum_sq / (float)hidden_dim + 1e-6f);
    float normed = input[idx] * inv_rms * (1.0f + norm_scale[idx]);
    float gate = gate_up[idx];
    float up = gate_up[hidden_dim + idx];
    out[idx] = gelu_tanh(normed * gate) * up;
}

int main() {
    printf("{\"kernel\":\"gemma4_fused_rmsnorm_geglu_sm89\",\"arch\":\"sm_89\",\"status\":\"ready\"}\\n");
    return 0;
}
`;
    writeFileSafeUserspace(filePath, sourceCode);
    return {
      style,
      modelId,
      filePath: filePath.replace(/\\/g, "/"),
      runCommand: `nvcc -arch=sm_89 -O3 "${filePath.replace(/\\/g, "/")}" -o "${outDir.replace(/\\/g, "/")}/gemma4_sm89.exe"`,
      sourceCode,
    };
  }

  const filePath = join(outDir, "train_gemma4_torch_heretic.py");
  const sourceCode = `# Gemma 4 PyTorch SDPA + QLoRA + Heretic Orthogonal Refusal Abliteration Pipeline
# Run with: uv run --with torch --with safetensors python train_gemma4_torch_heretic.py
from __future__ import annotations
import torch
import torch.nn.functional as F

MODEL_ID = "${modelId}"
LORA_RANK = ${loraRank}

def heretic_abliterate_projection(weight: torch.Tensor, refusal_dir: torch.Tensor, scale: float = 1.0) -> torch.Tensor:
    unit_dir = F.normalize(refusal_dir, dim=0)
    proj = torch.matmul(weight, unit_dir).unsqueeze(1) * unit_dir.unsqueeze(0)
    return weight - scale * proj

def gemma4_sdpa_step(q: torch.Tensor, k: torch.Tensor, v: torch.Tensor) -> torch.Tensor:
    return F.scaled_dot_product_attention(q, k, v, is_causal=True)

if __name__ == "__main__":
    device = "cuda" if torch.cuda.is_available() else "cpu"
    w = torch.randn(1024, 1024, device=device)
    r = torch.randn(1024, device=device)
    w_clean = heretic_abliterate_projection(w, r)
    residual = float(torch.matmul(w_clean, F.normalize(r, dim=0)).abs().max().item())
    print({"model": MODEL_ID, "device": device, "max_refusal_projection": residual})
`;
  writeFileSafeUserspace(filePath, sourceCode);
  return {
    style,
    modelId,
    filePath: filePath.replace(/\\/g, "/"),
    runCommand: `uv run --with torch python "${filePath.replace(/\\/g, "/")}"`,
    sourceCode,
  };
}

export async function runGemma4KeylessInference(params: {
  prompt: string;
  system?: string;
  modelId?: string;
  enableThinking?: boolean;
  imagesCount?: number;
}): Promise<{
  ok: boolean;
  selectedModel: string;
  formattedGemmaPrompt: string;
  providerUsed: string;
  answer: string;
}> {
  const fit = selectOptimalGemma4Model();
  const selectedModel = params.modelId ?? fit.model.id;
  const turns: Gemma4Turn[] = [];
  if (params.system) {
    turns.push({ role: "system", content: params.system });
  }
  turns.push({
    role: "user",
    content: params.prompt,
    imagesCount: params.imagesCount,
  });

  const formattedGemmaPrompt = formatGemma4Prompt(turns, {
    enableThinking: params.enableThinking,
    addGenerationPrompt: true,
  });

  const completion = await federateChatCompletion({
    model: selectedModel,
    messages: [
      ...(params.system
        ? [{ role: "system" as const, content: params.system }]
        : []),
      { role: "user" as const, content: params.prompt },
    ],
  });

  return {
    ok: true,
    selectedModel,
    formattedGemmaPrompt,
    providerUsed: completion.provider,
    answer: completion.choices[0]?.message.content ?? "",
  };
}
