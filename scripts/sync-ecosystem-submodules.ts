import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface EcosystemRepoSpec {
  readonly category:
    | "ggml-org"
    | "astral-sh"
    | "python-rust"
    | "huggingface"
    | "openai"
    | "nvidia"
    | "pytorch"
    | "llm-2026"
    | "rag-bigdata"
    | "tree-sitter"
    | "uncensored"
    | "system1-decisional";
  readonly path: string;
  readonly repo: string;
  readonly branch: string;
  readonly description: string;
}

export const ECOSYSTEM_REPOS: readonly EcosystemRepoSpec[] = [
  // 1. ggml-org (Priority 1: Bare-Metal C/C++/CUDA Inference, Whisper, GGUF)
  {
    category: "ggml-org",
    path: "submodules/ggml-org/llama.cpp",
    repo: "ggml-org/llama.cpp",
    branch: "master",
    description: "LLM inference in C/C++ with CUDA sm_89 Tensor Core kernels",
  },
  {
    category: "ggml-org",
    path: "submodules/ggml-org/whisper.cpp",
    repo: "ggml-org/whisper.cpp",
    branch: "master",
    description: "High-performance C/C++ & CUDA ASR port of OpenAI Whisper",
  },
  {
    category: "ggml-org",
    path: "submodules/ggml-org/ggml",
    repo: "ggml-org/ggml",
    branch: "master",
    description: "Bare-metal C/CUDA quantized tensor library for ML",
  },
  {
    category: "ggml-org",
    path: "submodules/ggml-org/Llama-Windows",
    repo: "ggml-org/Llama-Windows",
    branch: "main",
    description: "Official Windows native Llama companion",
  },
  {
    category: "ggml-org",
    path: "submodules/ggml-org/llama.vscode",
    repo: "ggml-org/llama.vscode",
    branch: "master",
    description: "Local FIM code/text completion extension",
  },
  {
    category: "ggml-org",
    path: "submodules/ggml-org/llama.vim",
    repo: "ggml-org/llama.vim",
    branch: "master",
    description: "Local LLM completion plugin for Vim/Neovim",
  },
  {
    category: "ggml-org",
    path: "submodules/ggml-org/convert",
    repo: "ggml-org/convert",
    branch: "master",
    description: "Safetensors/PyTorch to GGUF model converter",
  },
  {
    category: "ggml-org",
    path: "submodules/ggml-org/p1",
    repo: "ggml-org/p1",
    branch: "main",
    description: "LLM-based code completion engine",
  },

  // 2. astral-sh (Rust-Powered Python Toolchain: uv, ruff, ty, standalone builds, codecs)
  {
    category: "astral-sh",
    path: "submodules/astral-sh/uv",
    repo: "astral-sh/uv",
    branch: "main",
    description:
      "Ultra-fast Python package, project, and runtime manager in Rust",
  },
  {
    category: "astral-sh",
    path: "submodules/astral-sh/ruff",
    repo: "astral-sh/ruff",
    branch: "main",
    description: "Ultra-fast Python linter and code formatter in Rust",
  },
  {
    category: "astral-sh",
    path: "submodules/astral-sh/ty",
    repo: "astral-sh/ty",
    branch: "main",
    description: "Ultra-fast Python static type checker and LSP in Rust",
  },
  {
    category: "astral-sh",
    path: "submodules/astral-sh/python-build-standalone",
    repo: "astral-sh/python-build-standalone",
    branch: "main",
    description:
      "PGO+LTO redistributable CPython builds (including free-threaded 3.15t)",
  },
  {
    category: "astral-sh",
    path: "submodules/astral-sh/astral-codec",
    repo: "astral-sh/astral-codec",
    branch: "main",
    description: "Fast async format encoders/decoders in Rust",
  },
  {
    category: "astral-sh",
    path: "submodules/astral-sh/astral-yaml",
    repo: "astral-sh/astral-yaml",
    branch: "main",
    description: "High-performance YAML 1.2 parser in safe Rust",
  },
  {
    category: "astral-sh",
    path: "submodules/astral-sh/astral-html",
    repo: "astral-sh/astral-html",
    branch: "main",
    description: "High-performance HTML parser for document traversal",
  },
  {
    category: "astral-sh",
    path: "submodules/astral-sh/astral-ini",
    repo: "astral-sh/astral-ini",
    branch: "main",
    description: "High-performance INI parser for Python packaging",
  },
  {
    category: "astral-sh",
    path: "submodules/astral-sh/pubgrub",
    repo: "astral-sh/pubgrub",
    branch: "main",
    description: "PubGrub version solving algorithm in Rust",
  },
  {
    category: "astral-sh",
    path: "submodules/astral-sh/hawk",
    repo: "astral-sh/hawk",
    branch: "main",
    description: "Workspace-aware Cargo lint for unnecessary public Rust APIs",
  },
  {
    category: "astral-sh",
    path: "submodules/astral-sh/toucan",
    repo: "astral-sh/toucan",
    branch: "main",
    description:
      "Pure-Rust C frontend for generating Rust FFI bindings without libclang",
  },
  {
    category: "astral-sh",
    path: "submodules/astral-sh/xeme",
    repo: "astral-sh/xeme",
    branch: "main",
    description: "Streaming XML parser in Rust with Expat-compatible C ABI",
  },
  {
    category: "astral-sh",
    path: "submodules/astral-sh/agent-plugins",
    repo: "astral-sh/agent-plugins",
    branch: "main",
    description: "Official Astral coding agent skills & plugins",
  },

  // 3. Python + Rust Interop Core (CPython, PyO3, Maturin, NumPy-Rust, Pydantic)
  {
    category: "python-rust",
    path: "submodules/python-rust/cpython",
    repo: "python/cpython",
    branch: "main",
    description: "Canonical CPython runtime (PEP 703 free-threading + JIT)",
  },
  {
    category: "python-rust",
    path: "submodules/python-rust/pyo3",
    repo: "PyO3/pyo3",
    branch: "main",
    description: "Zero-overhead Rust bindings for CPython & free-threaded ABI",
  },
  {
    category: "python-rust",
    path: "submodules/python-rust/maturin",
    repo: "PyO3/maturin",
    branch: "main",
    description:
      "Build and publish PyO3, CFFI, and UniFFI Rust crates as Python wheels",
  },
  {
    category: "python-rust",
    path: "submodules/python-rust/rust-numpy",
    repo: "PyO3/rust-numpy",
    branch: "main",
    description: "Zero-copy PyO3 Rust bindings for NumPy C-API ndarrays",
  },
  {
    category: "python-rust",
    path: "submodules/python-rust/pyo3-async-runtimes",
    repo: "PyO3/pyo3-async-runtimes",
    branch: "main",
    description: "Bridges between Python asyncio and Rust Tokio runtimes",
  },
  {
    category: "python-rust",
    path: "submodules/python-rust/pydantic",
    repo: "pydantic/pydantic",
    branch: "main",
    description: "Rust-accelerated data validation (pydantic-core)",
  },
  {
    category: "python-rust",
    path: "submodules/python-rust/pydantic-ai",
    repo: "pydantic/pydantic-ai",
    branch: "main",
    description: "Type-safe GenAI agent framework for Python",
  },

  // 4. Hugging Face Ecosystem (Zero-Copy Safetensors, Rust Tokenizers, Candle, Training, RAG)
  {
    category: "huggingface",
    path: "submodules/huggingface/safetensors",
    repo: "huggingface/safetensors",
    branch: "main",
    description: "Zero-copy mmap safe tensor serialization in Rust/Python/C",
  },
  {
    category: "huggingface",
    path: "submodules/huggingface/tokenizers",
    repo: "huggingface/tokenizers",
    branch: "main",
    description: "Fast state-of-the-art Rust BPE/WordPiece/Unigram tokenizers",
  },
  {
    category: "huggingface",
    path: "submodules/huggingface/candle",
    repo: "huggingface/candle",
    branch: "main",
    description:
      "Minimalist serverless Rust ML & LLM framework with CUDA kernels",
  },
  {
    category: "huggingface",
    path: "submodules/huggingface/transformers",
    repo: "huggingface/transformers",
    branch: "main",
    description:
      "Canonical model-definition framework for text, vision, audio, multimodal",
  },
  {
    category: "huggingface",
    path: "submodules/huggingface/peft",
    repo: "huggingface/peft",
    branch: "main",
    description: "Parameter-Efficient Fine-Tuning (LoRA, QLoRA, DoRA)",
  },
  {
    category: "huggingface",
    path: "submodules/huggingface/trl",
    repo: "huggingface/trl",
    branch: "main",
    description: "Post-training Transformers with RLHF, GRPO, DPO, SFT",
  },
  {
    category: "huggingface",
    path: "submodules/huggingface/accelerate",
    repo: "huggingface/accelerate",
    branch: "main",
    description: "FP8/BF16 mixed precision, FSDP2, DeepSpeed training launcher",
  },
  {
    category: "huggingface",
    path: "submodules/huggingface/datasets",
    repo: "huggingface/datasets",
    branch: "main",
    description:
      "Zero-copy Apache Arrow backed ML dataset streaming & processing",
  },
  {
    category: "huggingface",
    path: "submodules/huggingface/diffusers",
    repo: "huggingface/diffusers",
    branch: "main",
    description: "State-of-the-art image, video, and audio diffusion models",
  },
  {
    category: "huggingface",
    path: "submodules/huggingface/sentence-transformers",
    repo: "huggingface/sentence-transformers",
    branch: "main",
    description:
      "Dense, sparse, and ColBERT embeddings + cross-encoder rerankers for RAG",
  },
  {
    category: "huggingface",
    path: "submodules/huggingface/text-embeddings-inference",
    repo: "huggingface/text-embeddings-inference",
    branch: "main",
    description:
      "Blazing-fast Rust + Candle + CUDA server for RAG embeddings/reranking",
  },
  {
    category: "huggingface",
    path: "submodules/huggingface/smolagents",
    repo: "huggingface/smolagents",
    branch: "main",
    description: "Code-first minimalist agent library",
  },

  // 5. OpenAI Flagship Open-Source Repos
  {
    category: "openai",
    path: "submodules/openai/codex",
    repo: "openai/codex",
    branch: "main",
    description: "Lightweight Rust/TS terminal coding agent",
  },
  {
    category: "openai",
    path: "submodules/openai/tiktoken",
    repo: "openai/tiktoken",
    branch: "main",
    description: "Fast Rust BPE tokenizer with PyO3 bindings",
  },
  {
    category: "openai",
    path: "submodules/openai/whisper",
    repo: "openai/whisper",
    branch: "main",
    description: "Reference PyTorch multilingual speech recognition",
  },
  {
    category: "openai",
    path: "submodules/openai/gpt-oss",
    repo: "openai/gpt-oss",
    branch: "main",
    description: "OpenAI gpt-oss-120b and gpt-oss-20b open-weight models",
  },
  {
    category: "openai",
    path: "submodules/openai/openai-python",
    repo: "openai/openai-python",
    branch: "main",
    description: "Official typed Python client for OpenAI-compatible APIs",
  },
  {
    category: "openai",
    path: "submodules/openai/openai-agents-python",
    repo: "openai/openai-agents-python",
    branch: "main",
    description: "Multi-agent orchestration SDK",
  },
  {
    category: "openai",
    path: "submodules/openai/evals",
    repo: "openai/evals",
    branch: "main",
    description: "LLM benchmark and evaluation harness",
  },
  {
    category: "openai",
    path: "submodules/openai/CLIP",
    repo: "openai/CLIP",
    branch: "main",
    description: "Contrastive Language-Image Pretraining",
  },

  // 6. NVIDIA GPU / CUDA / Deep ML / Big Data Flagship Repos
  {
    category: "nvidia",
    path: "submodules/nvidia/cutlass",
    repo: "NVIDIA/cutlass",
    branch: "main",
    description:
      "CUDA C++ templates & CuTe Python DSL for Tensor Core GEMM/FMHA (sm_89+)",
  },
  {
    category: "nvidia",
    path: "submodules/nvidia/cccl",
    repo: "NVIDIA/cccl",
    branch: "main",
    description: "CUDA Core Compute Libraries (Thrust, CUB, libcudacxx)",
  },
  {
    category: "nvidia",
    path: "submodules/nvidia/TensorRT-LLM",
    repo: "NVIDIA/TensorRT-LLM",
    branch: "main",
    description: "FP8/INT4/AWQ TensorRT inference engine for NVIDIA GPUs",
  },
  {
    category: "nvidia",
    path: "submodules/nvidia/Megatron-LM",
    repo: "NVIDIA/Megatron-LM",
    branch: "main",
    description: "3D-parallel large-scale Transformer pretraining",
  },
  {
    category: "nvidia",
    path: "submodules/nvidia/TransformerEngine",
    repo: "NVIDIA/TransformerEngine",
    branch: "main",
    description: "Ada Lovelace sm_89 / Hopper FP8 Transformer acceleration",
  },
  {
    category: "nvidia",
    path: "submodules/nvidia/Model-Optimizer",
    repo: "NVIDIA/Model-Optimizer",
    branch: "main",
    description:
      "FP8/NVFP4 quantization, pruning, distillation, speculative decoding",
  },
  {
    category: "nvidia",
    path: "submodules/nvidia/cudf",
    repo: "NVIDIA/cudf",
    branch: "main",
    description: "RAPIDS GPU DataFrame library (Apache Arrow on CUDA)",
  },
  {
    category: "nvidia",
    path: "submodules/nvidia/cuml",
    repo: "NVIDIA/cuml",
    branch: "main",
    description: "RAPIDS GPU-accelerated classical ML algorithms",
  },
  {
    category: "nvidia",
    path: "submodules/nvidia/DALI",
    repo: "NVIDIA/DALI",
    branch: "main",
    description: "Zero-bottleneck GPU data loading & augmentation pipeline",
  },
  {
    category: "nvidia",
    path: "submodules/nvidia/warp",
    repo: "NVIDIA/warp",
    branch: "main",
    description: "Python-to-CUDA JIT kernel compiler for simulation and ML",
  },
  {
    category: "nvidia",
    path: "submodules/nvidia/garak",
    repo: "NVIDIA/garak",
    branch: "main",
    description: "LLM red-teaming, probe, and security scanner",
  },

  // 7. PyTorch Native Core (PyTorch, TorchTitan, TorchAO, ExecuTorch)
  {
    category: "pytorch",
    path: "submodules/pytorch/pytorch",
    repo: "pytorch/pytorch",
    branch: "main",
    description:
      "Tensors and dynamic neural networks with torch.compile Inductor CUDA",
  },
  {
    category: "pytorch",
    path: "submodules/pytorch/torchtitan",
    repo: "pytorch/torchtitan",
    branch: "main",
    description: "Clean-room PyTorch native pretraining platform",
  },
  {
    category: "pytorch",
    path: "submodules/pytorch/ao",
    repo: "pytorch/ao",
    branch: "main",
    description: "PyTorch native FP8/INT4/INT8 quantization & sparsity",
  },
  {
    category: "pytorch",
    path: "submodules/pytorch/executorch",
    repo: "pytorch/executorch",
    branch: "main",
    description: "AOT portable edge/bare-metal runtime for PyTorch",
  },

  // 8. 2026 LLM Inference, Kernels, Training & Uncensored Stack
  {
    category: "llm-2026",
    path: "submodules/llm-2026/vllm",
    repo: "vllm-project/vllm",
    branch: "main",
    description: "PagedAttention high-throughput LLM serving engine",
  },
  {
    category: "llm-2026",
    path: "submodules/llm-2026/sglang",
    repo: "sgl-project/sglang",
    branch: "main",
    description: "RadixAttention fast structured LLM/VLM serving framework",
  },
  {
    category: "llm-2026",
    path: "submodules/llm-2026/unsloth",
    repo: "unslothai/unsloth",
    branch: "main",
    description:
      "2x faster, 70% less VRAM Triton kernels for QLoRA/GRPO fine-tuning on 12GB GPUs",
  },
  {
    category: "llm-2026",
    path: "submodules/llm-2026/flash-attention",
    repo: "Dao-AILab/flash-attention",
    branch: "main",
    description: "IO-aware exact attention CUDA kernels (FlashAttention-2/3)",
  },
  {
    category: "llm-2026",
    path: "submodules/llm-2026/flashinfer",
    repo: "flashinfer-ai/flashinfer",
    branch: "main",
    description:
      "Customizable prefill/decode/PagedAttention CUDA kernels for LLM serving",
  },
  {
    category: "llm-2026",
    path: "submodules/llm-2026/triton",
    repo: "triton-lang/triton",
    branch: "main",
    description: "Tile-based GPU kernel compiler for Deep Learning",
  },
  {
    category: "llm-2026",
    path: "submodules/llm-2026/mistral.rs",
    repo: "EricLBuehler/mistral.rs",
    branch: "master",
    description:
      "Blazing-fast pure-Rust + CUDA ISQ multimodal LLM inference engine",
  },
  {
    category: "llm-2026",
    path: "submodules/llm-2026/outlines",
    repo: "dottxt-ai/outlines",
    branch: "main",
    description: "Zero-overhead FSM/CFG structured generation",
  },
  {
    category: "llm-2026",
    path: "submodules/llm-2026/dspy",
    repo: "stanfordnlp/dspy",
    branch: "main",
    description:
      "Declarative self-optimizing prompt & RAG programming framework",
  },

  // 9. Sovereign Uncensored / Abliteration Stack
  {
    category: "uncensored",
    path: "submodules/uncensored/heretic",
    repo: "p-e-w/heretic",
    branch: "main",
    description:
      "Directional activation abliteration & refusal-suppression engine for open-weights LLMs",
  },
  {
    category: "uncensored",
    path: "submodules/uncensored/locally-uncensored",
    repo: "PurpleDoubleD/locally-uncensored",
    branch: "main",
    description:
      "Sovereign local uncensored model catalog & zero-refusal runtime",
  },

  // 10. RAG, Vector Search & Zero-Copy Big Data (Polars, DuckDB, Arrow-rs, LanceDB, Qdrant, USearch)
  {
    category: "rag-bigdata",
    path: "submodules/rag-bigdata/polars",
    repo: "pola-rs/polars",
    branch: "main",
    description:
      "SIMD/multithreaded Rust DataFrame query engine over Apache Arrow",
  },
  {
    category: "rag-bigdata",
    path: "submodules/rag-bigdata/duckdb",
    repo: "duckdb/duckdb",
    branch: "main",
    description: "In-process analytical OLAP SQL +VSS vector database",
  },
  {
    category: "rag-bigdata",
    path: "submodules/rag-bigdata/arrow-rs",
    repo: "apache/arrow-rs",
    branch: "main",
    description:
      "Official Rust Apache Arrow & Parquet zero-copy memory implementation",
  },
  {
    category: "rag-bigdata",
    path: "submodules/rag-bigdata/lancedb",
    repo: "lancedb/lancedb",
    branch: "main",
    description:
      "Embedded multimodal Rust vector DB for disk-backed zero-copy RAG",
  },
  {
    category: "rag-bigdata",
    path: "submodules/rag-bigdata/qdrant",
    repo: "qdrant/qdrant",
    branch: "master",
    description: "High-performance Rust HNSW vector similarity search engine",
  },
  {
    category: "rag-bigdata",
    path: "submodules/rag-bigdata/USearch",
    repo: "unum-cloud/USearch",
    branch: "main",
    description: "Single-header SIMD AVX2/FP16 HNSW vector search engine",
  },

  // 11. Tree-sitter AST & Polyglot Code Intelligence (AOT C parsers)
  {
    category: "tree-sitter",
    path: "submodules/tree-sitter/tree-sitter",
    repo: "tree-sitter/tree-sitter",
    branch: "master",
    description: "Incremental GLR parsing system in C & Rust",
  },
  {
    category: "tree-sitter",
    path: "submodules/tree-sitter/tree-sitter-python",
    repo: "tree-sitter/tree-sitter-python",
    branch: "master",
    description: "Tree-sitter Python grammar",
  },
  {
    category: "tree-sitter",
    path: "submodules/tree-sitter/tree-sitter-rust",
    repo: "tree-sitter/tree-sitter-rust",
    branch: "master",
    description: "Tree-sitter Rust grammar",
  },
  {
    category: "tree-sitter",
    path: "submodules/tree-sitter/tree-sitter-cpp",
    repo: "tree-sitter/tree-sitter-cpp",
    branch: "master",
    description: "Tree-sitter C++ grammar",
  },
  {
    category: "tree-sitter",
    path: "submodules/tree-sitter/tree-sitter-cuda",
    repo: "tree-sitter-grammars/tree-sitter-cuda",
    branch: "master",
    description: "Tree-sitter CUDA C++ grammar",
  },
  {
    category: "tree-sitter",
    path: "submodules/tree-sitter/tree-sitter-typescript",
    repo: "tree-sitter/tree-sitter-typescript",
    branch: "master",
    description: "Tree-sitter TypeScript/TSX grammar",
  },

  // 12. System-1 Decisional Models, Grammar FSMs & Bare-Metal CPU+SSD+RAM Inference
  {
    category: "system1-decisional",
    path: "submodules/system1-decisional/BitNet",
    repo: "microsoft/BitNet",
    branch: "main",
    description:
      "1.58-bit ternary LLM inference framework (bitnet.cpp) for pure CPU+RAM without GPU",
  },
  {
    category: "system1-decisional",
    path: "submodules/system1-decisional/PowerInfer",
    repo: "Tiiny-AI/PowerInfer",
    branch: "main",
    description: "Hot/cold neuron-sparsity CPU + NVMe SSD LLM inference engine",
  },
  {
    category: "system1-decisional",
    path: "submodules/system1-decisional/ktransformers",
    repo: "kvcache-ai/ktransformers",
    branch: "main",
    description:
      "CPU AVX2/AMX + SSD/RAM heterogeneous MoE & attention kernel engine",
  },
  {
    category: "system1-decisional",
    path: "submodules/system1-decisional/plano",
    repo: "katanemo/plano",
    branch: "main",
    description:
      "Katanemo Arch-Function / Arch-Router System-1 agentic gateway & prompt router",
  },
  {
    category: "system1-decisional",
    path: "submodules/system1-decisional/xLAM",
    repo: "SalesforceAIResearch/xLAM",
    branch: "main",
    description:
      "Large Action Models (xLAM-2 1B/3B/8B) & APIGen verifiable function-calling pipeline",
  },
  {
    category: "system1-decisional",
    path: "submodules/system1-decisional/Hammer",
    repo: "MadeAgents/Hammer",
    branch: "main",
    description:
      "Hammer 2.1 (0.5B/1.5B/3B) function-masking System-1 tool-calling models",
  },
  {
    category: "system1-decisional",
    path: "submodules/system1-decisional/functionary",
    repo: "MeetKai/functionary",
    branch: "main",
    description:
      "MeetKai Functionary native tool-calling & code-act parser/spec",
  },
  {
    category: "system1-decisional",
    path: "submodules/system1-decisional/gorilla",
    repo: "ShishirPatil/gorilla",
    branch: "main",
    description:
      "UC Berkeley Gorilla API bench (BFCL) & AST-verified tool invocation",
  },
  {
    category: "system1-decisional",
    path: "submodules/system1-decisional/llguidance",
    repo: "guidance-ai/llguidance",
    branch: "main",
    description:
      "Sub-50us Rust Earley/FSM logit-masking engine converting verbose LLMs to strict schemas",
  },
  {
    category: "system1-decisional",
    path: "submodules/system1-decisional/xgrammar",
    repo: "mlc-ai/xgrammar",
    branch: "main",
    description:
      "Zero-overhead pushdown automaton structured generation engine for System-1 JSON/CFG",
  },
];

const GIT_BIN =
  process.platform === "win32" &&
  existsSync("C:\\Program Files\\Git\\cmd\\git.exe")
    ? "C:\\Program Files\\Git\\cmd\\git.exe"
    : (Bun.which("git") ?? "git");

function runGitSync(
  args: string[],
  cwd: string,
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(
    [
      GIT_BIN,
      "-c",
      "core.longpaths=true",
      "-c",
      "protocol.file.allow=always",
      ...args,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString("utf8").trim(),
    stderr: proc.stderr.toString("utf8").trim(),
  };
}

export function generateGitmodulesContent(
  specs: readonly EcosystemRepoSpec[],
): string {
  const blocks = specs.map(
    (s) =>
      `[submodule "${s.path}"]\n\tpath = ${s.path}\n\turl = https://github.com/${s.repo}.git\n\tbranch = ${s.branch}\n\tshallow = true`,
  );
  return `${blocks.join("\n")}\n`;
}

export interface ClonedSubmoduleStatus {
  category: string;
  path: string;
  repo: string;
  branch: string;
  description: string;
  commitSha: string;
  committedAt: string;
  commitSubject: string;
}

export async function syncEcosystemSubmodules(
  options: {
    rootDir?: string;
    concurrency?: number;
    manifestOnly?: boolean;
  } = {},
) {
  const rootDir = resolve(options.rootDir ?? join(import.meta.dir, ".."));
  const concurrency = options.concurrency ?? 8;

  // 1. Write deterministic .gitmodules
  const gitmodulesPath = join(rootDir, ".gitmodules");
  writeFileSync(
    gitmodulesPath,
    generateGitmodulesContent(ECOSYSTEM_REPOS),
    "utf8",
  );

  // 2. Parallel shallow blobless clone (--depth 1 --filter=blob:none --no-tags --single-branch)
  if (!options.manifestOnly) {
    let cursor = 0;
    const errors: string[] = [];

    const worker = async () => {
      while (cursor < ECOSYSTEM_REPOS.length) {
        const spec = ECOSYSTEM_REPOS[cursor++]!;
        const targetDir = join(rootDir, spec.path);
        const gitIndicator = join(targetDir, ".git");
        const url = `https://github.com/${spec.repo}.git`;

        if (!existsSync(gitIndicator)) {
          mkdirSync(dirname(targetDir), { recursive: true });
          const cloneArgs = [
            GIT_BIN,
            "-c",
            "core.longpaths=true",
            "clone",
            "--depth",
            "1",
            "--filter=blob:none",
            "--single-branch",
            "--no-tags",
            "--branch",
            spec.branch,
            url,
            targetDir,
          ];
          const proc = Bun.spawn(cloneArgs, {
            cwd: rootDir,
            stdout: "ignore",
            stderr: "pipe",
          });
          const code = await proc.exited;
          if (code !== 0) {
            const errText = await new Response(proc.stderr).text();
            // Fallback without --branch in case default branch changed upstream
            const fallbackProc = Bun.spawn(
              [
                GIT_BIN,
                "-c",
                "core.longpaths=true",
                "clone",
                "--depth",
                "1",
                "--filter=blob:none",
                "--single-branch",
                "--no-tags",
                url,
                targetDir,
              ],
              { cwd: rootDir, stdout: "ignore", stderr: "pipe" },
            );
            const fallbackCode = await fallbackProc.exited;
            if (fallbackCode !== 0) {
              const fbErr = await new Response(fallbackProc.stderr).text();
              errors.push(`${spec.repo}: ${errText.trim()} | ${fbErr.trim()}`);
              continue;
            }
          }
          console.log(`[submodules] Cloned ${spec.repo} -> ${spec.path}`);
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (errors.length > 0) {
      console.error(`[submodules] Encountered ${errors.length} clone errors:`);
      for (const e of errors) console.error(`  - ${e}`);
    }

    // 3. Register gitlinks in parent index sequentially (safe against .git/index.lock)
    for (const spec of ECOSYSTEM_REPOS) {
      const targetDir = join(rootDir, spec.path);
      if (!existsSync(join(targetDir, ".git"))) continue;

      const shaRes = runGitSync(["rev-parse", "HEAD"], targetDir);
      if (shaRes.exitCode !== 0 || !shaRes.stdout) continue;

      // Register gitlink mode 160000 in C:\src\ai-os git index
      runGitSync(
        [
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${shaRes.stdout},${spec.path}`,
        ],
        rootDir,
      );
      runGitSync(
        [
          "config",
          "-f",
          ".git/config",
          `submodule.${spec.path}.url`,
          `https://github.com/${spec.repo}.git`,
        ],
        rootDir,
      );
      runGitSync(
        [
          "config",
          "-f",
          ".git/config",
          `submodule.${spec.path}.active`,
          "true",
        ],
        rootDir,
      );
    }
    runGitSync(["add", ".gitmodules"], rootDir);
  }

  // 4. Emit SUBMODULES_ECOSYSTEM_MANIFEST.json & Markdown summary
  const syncedAt = new Date().toISOString();
  const entries: ClonedSubmoduleStatus[] = [];

  for (const spec of ECOSYSTEM_REPOS) {
    const targetDir = join(rootDir, spec.path);
    if (!existsSync(join(targetDir, ".git"))) continue;
    const logRes = runGitSync(
      ["log", "-1", "--format=%H%x09%cI%x09%s"],
      targetDir,
    );
    const parts = logRes.stdout.split("\t");
    entries.push({
      category: spec.category,
      path: spec.path,
      repo: spec.repo,
      branch: spec.branch,
      description: spec.description,
      commitSha: parts[0] ?? "",
      committedAt: parts[1] ?? syncedAt,
      commitSubject: parts.slice(2).join("\t"),
    });
  }

  const byCategory: Record<string, number> = {};
  for (const e of entries) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
  }

  const manifest = {
    repository: "C:\\src\\ai-os",
    generatedAt: syncedAt,
    cloneStrategy:
      "git submodule shallow (--depth 1 --filter=blob:none --single-branch --no-tags, zero-vendor)",
    totalConfigured: ECOSYSTEM_REPOS.length,
    totalCloned: entries.length,
    byCategory,
    submodules: entries,
  };

  const manifestPath = join(rootDir, "SUBMODULES_ECOSYSTEM_MANIFEST.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(
    `[submodules] Registered ${entries.length}/${ECOSYSTEM_REPOS.length} submodules -> SUBMODULES_ECOSYSTEM_MANIFEST.json`,
  );
  return manifest;
}

if (import.meta.main) {
  const manifestOnly = process.argv.includes("--manifest-only");
  await syncEcosystemSubmodules({ manifestOnly });
}
