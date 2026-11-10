"""Sovereign AI-OS Polyglot Python Kernel (CUDA 13.x sm_89 + PyO3 Rust + Arrow/Polars/DuckDB)."""

from __future__ import annotations

import json
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import polars as pl
import pyarrow as pa
import tiktoken
import torch
from safetensors.torch import load_file as safetensors_load_torch
from safetensors.torch import save_file as safetensors_save_torch

import sovereign_polyglot_ffi as rust_ffi


def scan_python_cuda_polyglot() -> dict[str, Any]:
    """Run diagnostics across CPython, PyTorch CUDA sm_89, PyO3, Safetensors & Arrow."""
    gil_enabled = getattr(sys, "_is_gil_enabled", lambda: True)()
    cuda_ok = bool(torch.cuda.is_available())

    gpu_info: dict[str, Any] = {"cuda_available": cuda_ok}
    if cuda_ok:
        dev_props = torch.cuda.get_device_properties(0)
        # Benchmark BF16 & FP8/FP16 Tensor Core matmul on RTX 4070 sm_89
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        m_dim = 2048
        a_bf16 = torch.randn((m_dim, m_dim), device="cuda", dtype=torch.bfloat16)
        b_bf16 = torch.randn((m_dim, m_dim), device="cuda", dtype=torch.bfloat16)
        # Warmup
        _ = torch.matmul(a_bf16, b_bf16)
        torch.cuda.synchronize()

        t0 = time.perf_counter()
        for _ in range(5):
            _ = torch.matmul(a_bf16, b_bf16)
        torch.cuda.synchronize()
        dt = (time.perf_counter() - t0) / 5.0
        bf16_tflops = (2.0 * (m_dim**3) / dt) / 1e12

        # Scaled Dot-Product Attention (FlashAttention / CuDNN SDPA sm_89)
        q = torch.randn((4, 16, 1024, 64), device="cuda", dtype=torch.float16)
        k = torch.randn((4, 16, 1024, 64), device="cuda", dtype=torch.float16)
        v = torch.randn((4, 16, 1024, 64), device="cuda", dtype=torch.float16)
        _ = torch.nn.functional.scaled_dot_product_attention(q, k, v, is_causal=True)
        torch.cuda.synchronize()
        t_sdpa0 = time.perf_counter()
        for _ in range(10):
            _ = torch.nn.functional.scaled_dot_product_attention(q, k, v, is_causal=True)
        torch.cuda.synchronize()
        sdpa_ms = ((time.perf_counter() - t_sdpa0) / 10.0) * 1000.0

        gpu_info = {
            "cuda_available": True,
            "torch_version": torch.__version__,
            "cuda_version": torch.version.cuda,
            "cudnn_version": torch.backends.cudnn.version(),
            "device_name": dev_props.name,
            "compute_capability": f"sm_{dev_props.major}{dev_props.minor}",
            "sm_count": dev_props.multi_processor_count,
            "total_vram_mb": round(dev_props.total_memory / (1024 * 1024), 2),
            "bf16_tensor_core_tflops": round(bf16_tflops, 2),
            "sdpa_flash_1k_latency_ms": round(sdpa_ms, 4),
        }

    # Zero-copy Safetensors <-> PyO3 Rust mmap verification
    with tempfile.TemporaryDirectory() as tmp_dir:
        st_path = Path(tmp_dir) / "zero_copy_weights.safetensors"
        sample_weights = {
            "layers.0.attn.wq": torch.ones((256, 256), dtype=torch.float32),
            "layers.0.mlp.w1": torch.arange(0, 1024, dtype=torch.float32).reshape(32, 32),
        }
        safetensors_save_torch(sample_weights, str(st_path))
        rust_st_meta = json.loads(rust_ffi.inspect_safetensors_json(str(st_path)))
        reloaded = safetensors_load_torch(str(st_path))
        st_verified = bool(
            rust_st_meta.get("ok")
            and rust_st_meta.get("zero_copy_mmap")
            and reloaded["layers.0.attn.wq"].shape == (256, 256)
        )

    # PyO3 Rust AVX2 + Rayon RAG Batch Cosine + Heretic Abliteration
    dim = 128
    num_docs = 2000
    rng = np.random.default_rng(42)
    q_vec = rng.standard_normal(dim, dtype=np.float32)
    corpus_vec = rng.standard_normal(num_docs * dim, dtype=np.float32)
    t_rag0 = time.perf_counter()
    scores = rust_ffi.batch_cosine_rag(q_vec.tolist(), corpus_vec.tolist(), dim)
    rag_ms = (time.perf_counter() - t_rag0) * 1000.0

    # Heretic directional refusal abliteration test: W' @ r == 0 when scale=1.0
    r_dir = np.zeros(dim, dtype=np.float32)
    r_dir[0] = 1.0
    w_mat = np.ones((16, dim), dtype=np.float32)
    abliterated = rust_ffi.heretic_abliterate(
        w_mat.flatten().tolist(),
        r_dir.tolist(),
        16,
        dim,
        1.0,
    )
    residual_dot = abs(abliterated[0])  # Projection along r_dir[0] must be 0.0

    # Zero-Copy Big Data: Polars <-> PyArrow <-> DuckDB SQL without copying buffers
    n_rows = 100_000
    df_pl = pl.DataFrame(
        {
            "doc_id": np.arange(n_rows, dtype=np.int64),
            "domain": ["llm-2026" if i % 2 == 0 else "cuda-sm89" for i in range(n_rows)],
            "tokens": np.arange(n_rows, dtype=np.float64) * 1.5,
        }
    )
    arrow_tbl: pa.Table = df_pl.to_arrow()
    t_sql0 = time.perf_counter()
    con = duckdb.connect(":memory:")
    con.register("arrow_zero_copy", arrow_tbl)
    agg_rows = con.execute(
        "SELECT domain, COUNT(*) AS cnt, SUM(tokens) AS total_tok "
        "FROM arrow_zero_copy GROUP BY domain ORDER BY domain"
    ).fetchall()
    duckdb_ms = (time.perf_counter() - t_sql0) * 1000.0

    # Tiktoken Rust BPE throughput check
    enc = tiktoken.get_encoding("o200k_base")
    bpe_tokens = enc.encode("Sovereign AI-OS CUDA sm_89 Rust PyO3 Zero-Copy Stack 2026")

    # Tree-sitter AST parse via Rust PyO3
    ast_info = json.loads(
        rust_ffi.parse_ast_json(
            "python",
            "class SovereignModel:\n    def forward(self, x):\n        return x\n",
        )
    )

    # System-1 CPU+SSD+RAM host tuner + Verbose-to-Decisional transducer via Rust PyO3
    host_tune = json.loads(rust_ffi.tune_host_cpu_ssd_json(None))
    transduced = json.loads(
        rust_ffi.transduce_verbose_json(
            "<think>Let me ponder for 500 tokens...</think>\n"
            '```json\n{"tool":"Bun.serve","arguments":{"port":4318}}\n```'
        )
    )

    return {
        "ok": True,
        "python": {
            "version": sys.version.split()[0],
            "executable": sys.executable.replace("\\", "/"),
            "gil_enabled": gil_enabled,
        },
        "pyo3_rust_ffi": {
            "abi_version": rust_ffi.abi_version(),
            "rag_2k_docs_cosine_ms": round(rag_ms, 3),
            "rag_scores_count": len(scores),
            "heretic_abliteration_residual": round(residual_dot, 8),
            "safetensors_zero_copy_verified": st_verified,
            "tree_sitter_symbols": len(ast_info.get("symbols", [])),
            "system1_host_tuned": bool(host_tune.get("ok")),
            "system1_transduced_decision": transduced.get("decision"),
            "system1_transduced_api": transduced.get("tool_or_api"),
        },
        "gpu_pytorch": gpu_info,
        "big_data_zero_copy": {
            "polars_version": pl.__version__,
            "pyarrow_version": pa.__version__,
            "duckdb_version": duckdb.__version__,
            "rows_queried": n_rows,
            "duckdb_over_arrow_ms": round(duckdb_ms, 3),
            "groups_returned": len(agg_rows),
        },
        "tokenizer_o200k_tokens": len(bpe_tokens),
    }


if __name__ == "__main__":
    print(json.dumps(scan_python_cuda_polyglot(), indent=2))
