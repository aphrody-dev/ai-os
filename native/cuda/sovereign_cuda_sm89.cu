#include <cuda_runtime.h>
#include <cuda_fp16.h>
#include <cuda_bf16.h>
#include <cuda_fp8.h>
#include <cublas_v2.h>
#include <cublasLt.h>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>

#ifdef _WIN32
#define SOV_CUDA_EXPORT extern "C" __declspec(dllexport)
#else
#define SOV_CUDA_EXPORT extern "C" __attribute__((visibility("default")))
#endif

// ============================================================================
// Sovereign Bare-Metal CUDA 13.4 (sm_89 Ada Lovelace) Kernel & FFI Engine
// Zero-Vendor, Device-LTO (-dlto), Pinned Zero-Copy DMA, cuBLAS Tensor Core
// ============================================================================

struct SovereignCudaTelemetry {
    int32_t ok;
    int32_t device_id;
    int32_t sm_count;
    int32_t compute_major;
    int32_t compute_minor;
    int32_t cuda_runtime_version;
    int32_t cuda_driver_version;
    uint64_t vram_total_bytes;
    uint64_t vram_free_bytes;
    uint64_t l2_cache_bytes;
    double fp32_fma_gflops;
    double fp16_tensor_tflops;
    double gddr6x_bandwidth_gbps;
    double zero_copy_pinned_gbps;
    char device_name[128];
};

__global__ void sov_fma_fp32_kernel(float* __restrict__ data, float alpha, float beta, int n, int iters) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx < n) {
        float v0 = data[idx];
        float v1 = v0 + 0.1f;
        float v2 = v0 + 0.2f;
        float v3 = v0 + 0.3f;
        #pragma unroll 8
        for (int i = 0; i < iters; ++i) {
            v0 = fmaf(v0, alpha, beta);
            v1 = fmaf(v1, alpha, beta);
            v2 = fmaf(v2, alpha, beta);
            v3 = fmaf(v3, alpha, beta);
        }
        data[idx] = v0 + v1 + v2 + v3;
    }
}

__global__ void sov_triad_gddr6x_kernel(
    const float* __restrict__ a,
    const float* __restrict__ b,
    float* __restrict__ c,
    float alpha,
    int n
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx < n) {
        c[idx] = a[idx] + alpha * b[idx];
    }
}

// Fused RMSNorm + Residual CUDA Kernel for LLM Inference / Training
__global__ void sov_rmsnorm_f32_kernel(
    const float* __restrict__ x,
    const float* __restrict__ weight,
    float* __restrict__ out,
    int hidden_dim,
    float eps
) {
    int row = blockIdx.x;
    int tid = threadIdx.x;
    const float* row_x = x + row * hidden_dim;
    float* row_out = out + row * hidden_dim;

    __shared__ float shared_sum[256];
    float local_sq = 0.0f;
    for (int i = tid; i < hidden_dim; i += blockDim.x) {
        float val = row_x[i];
        local_sq = fmaf(val, val, local_sq);
    }
    shared_sum[tid] = local_sq;
    __syncthreads();

    for (int stride = blockDim.x / 2; stride > 0; stride >>= 1) {
        if (tid < stride) {
            shared_sum[tid] += shared_sum[tid + stride];
        }
        __syncthreads();
    }

    float inv_rms = rsqrtf(shared_sum[0] / (float)hidden_dim + eps);
    for (int i = tid; i < hidden_dim; i += blockDim.x) {
        row_out[i] = row_x[i] * inv_rms * weight[i];
    }
}

// Batch Cosine Similarity RAG Retrieval Kernel (Zero-Copy Pinned Host or Device)
__global__ void sov_cosine_rag_batch_kernel(
    const float* __restrict__ query,      // [dim]
    const float* __restrict__ corpus,     // [num_docs * dim]
    float* __restrict__ scores_out,       // [num_docs]
    int num_docs,
    int dim
) {
    int doc_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (doc_idx < num_docs) {
        const float* doc = corpus + (size_t)doc_idx * dim;
        float dot = 0.0f;
        float norm_q = 0.0f;
        float norm_d = 0.0f;
        #pragma unroll 4
        for (int k = 0; k < dim; ++k) {
            float qv = query[k];
            float dv = doc[k];
            dot = fmaf(qv, dv, dot);
            norm_q = fmaf(qv, qv, norm_q);
            norm_d = fmaf(dv, dv, norm_d);
        }
        float denom = sqrtf(norm_q * norm_d);
        scores_out[doc_idx] = (denom > 1e-12f) ? (dot / denom) : 0.0f;
    }
}

// Heretic Directional Abliteration Kernel: W_out = W - scale * (W @ r) * r^T
// Projects out refusal direction vector r (unit normalized, [in_features]) from weight matrix [out_features, in_features]
__global__ void sov_heretic_abliterate_f32_kernel(
    float* __restrict__ weights,          // [out_features * in_features]
    const float* __restrict__ refusal_dir,// [in_features] (unit vector)
    int out_features,
    int in_features,
    float scale
) {
    int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row < out_features) {
        float* w_row = weights + (size_t)row * in_features;
        float proj = 0.0f;
        for (int j = 0; j < in_features; ++j) {
            proj = fmaf(w_row[j], refusal_dir[j], proj);
        }
        float coeff = scale * proj;
        for (int j = 0; j < in_features; ++j) {
            w_row[j] -= coeff * refusal_dir[j];
        }
    }
}

SOV_CUDA_EXPORT uint32_t sov_cuda_abi_version(void) {
    return 1;
}

SOV_CUDA_EXPORT int32_t sov_cuda_scan_and_bench(SovereignCudaTelemetry* out_telemetry, int32_t quick_mode) {
    if (!out_telemetry) return -1;
    std::memset(out_telemetry, 0, sizeof(SovereignCudaTelemetry));

    int count = 0;
    if (cudaGetDeviceCount(&count) != cudaSuccess || count <= 0) {
        out_telemetry->ok = 0;
        return -2;
    }

    int dev = 0;
    cudaSetDevice(dev);
    cudaDeviceProp prop{};
    if (cudaGetDeviceProperties(&prop, dev) != cudaSuccess) {
        return -3;
    }

    int runtime_ver = 0, driver_ver = 0;
    cudaRuntimeGetVersion(&runtime_ver);
    cudaDriverGetVersion(&driver_ver);

    size_t free_mem = 0, total_mem = 0;
    cudaMemGetInfo(&free_mem, &total_mem);

    out_telemetry->ok = 1;
    out_telemetry->device_id = dev;
    out_telemetry->sm_count = prop.multiProcessorCount;
    out_telemetry->compute_major = prop.major;
    out_telemetry->compute_minor = prop.minor;
    out_telemetry->cuda_runtime_version = runtime_ver;
    out_telemetry->cuda_driver_version = driver_ver;
    out_telemetry->vram_total_bytes = (uint64_t)total_mem;
    out_telemetry->vram_free_bytes = (uint64_t)free_mem;
    out_telemetry->l2_cache_bytes = (uint64_t)prop.l2CacheSize;
    std::snprintf(out_telemetry->device_name, sizeof(out_telemetry->device_name), "%s", prop.name);

    cudaEvent_t ev_start, ev_stop;
    cudaEventCreate(&ev_start);
    cudaEventCreate(&ev_stop);

    // 1. FP32 FMA GFLOPS
    const int compute_n = quick_mode ? (1 << 20) : (1 << 22);
    const int fma_iters = 256;
    float* d_compute = nullptr;
    if (cudaMalloc(&d_compute, (size_t)compute_n * sizeof(float)) == cudaSuccess) {
        cudaMemset(d_compute, 0, (size_t)compute_n * sizeof(float));
        int blocks = (compute_n + 255) / 256;
        sov_fma_fp32_kernel<<<blocks, 256>>>(d_compute, 1.0001f, 0.0001f, compute_n, 32);
        cudaDeviceSynchronize();

        float best_ms = 1e9f;
        int runs = quick_mode ? 2 : 4;
        for (int r = 0; r < runs; ++r) {
            cudaEventRecord(ev_start, 0);
            sov_fma_fp32_kernel<<<blocks, 256>>>(d_compute, 1.0001f, 0.0001f, compute_n, fma_iters);
            cudaEventRecord(ev_stop, 0);
            cudaEventSynchronize(ev_stop);
            float ms = 0.0f;
            cudaEventElapsedTime(&ms, ev_start, ev_stop);
            if (ms > 0.0f && ms < best_ms) best_ms = ms;
        }
        if (best_ms < 1e8f) {
            double flops = (double)compute_n * (double)fma_iters * 8.0;
            out_telemetry->fp32_fma_gflops = (flops / ((double)best_ms / 1000.0)) / 1e9;
        }
        cudaFree(d_compute);
    }

    // 2. GDDR6X Stream Triad Bandwidth
    const int stream_n = quick_mode ? (1 << 23) : (1 << 25); // 8M or 32M floats
    const size_t stream_bytes = (size_t)stream_n * sizeof(float);
    float *d_a = nullptr, *d_b = nullptr, *d_c = nullptr;
    if (cudaMalloc(&d_a, stream_bytes) == cudaSuccess &&
        cudaMalloc(&d_b, stream_bytes) == cudaSuccess &&
        cudaMalloc(&d_c, stream_bytes) == cudaSuccess) {
        cudaMemset(d_a, 1, stream_bytes);
        cudaMemset(d_b, 2, stream_bytes);
        int blocks = (stream_n + 255) / 256;
        sov_triad_gddr6x_kernel<<<blocks, 256>>>(d_a, d_b, d_c, 2.0f, stream_n);
        cudaDeviceSynchronize();

        float best_ms = 1e9f;
        int runs = quick_mode ? 2 : 4;
        for (int r = 0; r < runs; ++r) {
            cudaEventRecord(ev_start, 0);
            sov_triad_gddr6x_kernel<<<blocks, 256>>>(d_a, d_b, d_c, 2.0f, stream_n);
            cudaEventRecord(ev_stop, 0);
            cudaEventSynchronize(ev_stop);
            float ms = 0.0f;
            cudaEventElapsedTime(&ms, ev_start, ev_stop);
            if (ms > 0.0f && ms < best_ms) best_ms = ms;
        }
        if (best_ms < 1e8f) {
            double bytes_moved = (double)stream_bytes * 3.0;
            out_telemetry->gddr6x_bandwidth_gbps = (bytes_moved / ((double)best_ms / 1000.0)) / 1e9;
        }
    }
    if (d_a) cudaFree(d_a);
    if (d_b) cudaFree(d_b);
    if (d_c) cudaFree(d_c);

    // 3. FP16 Tensor Core GEMM via cuBLAS (Ada sm_89 HMMA Tensor Cores)
    cublasHandle_t cublas = nullptr;
    if (cublasCreate(&cublas) == CUBLAS_STATUS_SUCCESS) {
        cublasSetMathMode(cublas, CUBLAS_TENSOR_OP_MATH);
        const int M = quick_mode ? 2048 : 4096;
        const int N = M;
        const int K = M;
        size_t mat_bytes = (size_t)M * (size_t)N * sizeof(__half);
        __half *hA = nullptr, *hB = nullptr, *hC = nullptr;
        if (cudaMalloc(&hA, mat_bytes) == cudaSuccess &&
            cudaMalloc(&hB, mat_bytes) == cudaSuccess &&
            cudaMalloc(&hC, mat_bytes) == cudaSuccess) {
            cudaMemset(hA, 0x3C, mat_bytes);
            cudaMemset(hB, 0x3C, mat_bytes);
            cudaMemset(hC, 0, mat_bytes);
            float alpha = 1.0f, beta = 0.0f;
            // Warmup Tensor Cores
            cublasGemmEx(
                cublas, CUBLAS_OP_N, CUBLAS_OP_N, M, N, K,
                &alpha, hA, CUDA_R_16F, M, hB, CUDA_R_16F, K,
                &beta, hC, CUDA_R_16F, M,
                CUBLAS_COMPUTE_32F, CUBLAS_GEMM_DEFAULT_TENSOR_OP
            );
            cudaDeviceSynchronize();

            float best_ms = 1e9f;
            int runs = quick_mode ? 2 : 5;
            for (int r = 0; r < runs; ++r) {
                cudaEventRecord(ev_start, 0);
                cublasGemmEx(
                    cublas, CUBLAS_OP_N, CUBLAS_OP_N, M, N, K,
                    &alpha, hA, CUDA_R_16F, M, hB, CUDA_R_16F, K,
                    &beta, hC, CUDA_R_16F, M,
                    CUBLAS_COMPUTE_32F, CUBLAS_GEMM_DEFAULT_TENSOR_OP
                );
                cudaEventRecord(ev_stop, 0);
                cudaEventSynchronize(ev_stop);
                float ms = 0.0f;
                cudaEventElapsedTime(&ms, ev_start, ev_stop);
                if (ms < best_ms) best_ms = ms;
            }
            double gemm_flops = 2.0 * (double)M * (double)N * (double)K;
            out_telemetry->fp16_tensor_tflops = (gemm_flops / ((double)best_ms / 1000.0)) / 1e12;
        }
        if (hA) cudaFree(hA);
        if (hB) cudaFree(hB);
        if (hC) cudaFree(hC);
        cublasDestroy(cublas);
    }

    // 4. Zero-Copy Pinned Host DMA Bandwidth (cudaHostAllocMapped PCIe 4.0 x16)
    const size_t pinned_bytes = quick_mode ? (16ULL << 20) : (64ULL << 20);
    void* h_pinned = nullptr;
    void* d_buf = nullptr;
    if (cudaHostAlloc(&h_pinned, pinned_bytes, cudaHostAllocMapped) == cudaSuccess &&
        cudaMalloc(&d_buf, pinned_bytes) == cudaSuccess) {
        std::memset(h_pinned, 0x42, pinned_bytes);
        cudaMemcpyAsync(d_buf, h_pinned, pinned_bytes, cudaMemcpyHostToDevice, 0);
        cudaDeviceSynchronize();

        cudaEventRecord(ev_start, 0);
        cudaMemcpyAsync(d_buf, h_pinned, pinned_bytes, cudaMemcpyHostToDevice, 0);
        cudaEventRecord(ev_stop, 0);
        cudaEventSynchronize(ev_stop);
        float ms = 0.0f;
        cudaEventElapsedTime(&ms, ev_start, ev_stop);
        if (ms > 0.0f) {
            out_telemetry->zero_copy_pinned_gbps = ((double)pinned_bytes / ((double)ms / 1000.0)) / 1e9;
        }
    }
    if (d_buf) cudaFree(d_buf);
    if (h_pinned) cudaFreeHost(h_pinned);

    cudaEventDestroy(ev_start);
    cudaEventDestroy(ev_stop);
    return 0;
}

SOV_CUDA_EXPORT int32_t sov_cuda_cosine_rag(
    const float* query_host,
    const float* corpus_host,
    float* scores_host,
    int32_t num_docs,
    int32_t dim
) {
    if (!query_host || !corpus_host || !scores_host || num_docs <= 0 || dim <= 0) return -1;
    size_t q_bytes = (size_t)dim * sizeof(float);
    size_t c_bytes = (size_t)num_docs * (size_t)dim * sizeof(float);
    size_t s_bytes = (size_t)num_docs * sizeof(float);

    float *d_q = nullptr, *d_c = nullptr, *d_s = nullptr;
    if (cudaMalloc(&d_q, q_bytes) != cudaSuccess) return -2;
    if (cudaMalloc(&d_c, c_bytes) != cudaSuccess) { cudaFree(d_q); return -2; }
    if (cudaMalloc(&d_s, s_bytes) != cudaSuccess) { cudaFree(d_q); cudaFree(d_c); return -2; }

    cudaMemcpy(d_q, query_host, q_bytes, cudaMemcpyHostToDevice);
    cudaMemcpy(d_c, corpus_host, c_bytes, cudaMemcpyHostToDevice);

    int blocks = (num_docs + 255) / 256;
    sov_cosine_rag_batch_kernel<<<blocks, 256>>>(d_q, d_c, d_s, num_docs, dim);
    cudaMemcpy(scores_host, d_s, s_bytes, cudaMemcpyDeviceToHost);

    cudaFree(d_q);
    cudaFree(d_c);
    cudaFree(d_s);
    return 0;
}

SOV_CUDA_EXPORT int32_t sov_cuda_heretic_abliterate(
    float* weights_host,
    const float* refusal_dir_host,
    int32_t out_features,
    int32_t in_features,
    float scale
) {
    if (!weights_host || !refusal_dir_host || out_features <= 0 || in_features <= 0) return -1;
    size_t w_bytes = (size_t)out_features * (size_t)in_features * sizeof(float);
    size_t r_bytes = (size_t)in_features * sizeof(float);

    float *d_w = nullptr, *d_r = nullptr;
    if (cudaMalloc(&d_w, w_bytes) != cudaSuccess) return -2;
    if (cudaMalloc(&d_r, r_bytes) != cudaSuccess) { cudaFree(d_w); return -2; }

    cudaMemcpy(d_w, weights_host, w_bytes, cudaMemcpyHostToDevice);
    cudaMemcpy(d_r, refusal_dir_host, r_bytes, cudaMemcpyHostToDevice);

    int blocks = (out_features + 255) / 256;
    sov_heretic_abliterate_f32_kernel<<<blocks, 256>>>(d_w, d_r, out_features, in_features, scale);
    cudaMemcpy(weights_host, d_w, w_bytes, cudaMemcpyDeviceToHost);

    cudaFree(d_w);
    cudaFree(d_r);
    return 0;
}

SOV_CUDA_EXPORT int32_t sov_cuda_rmsnorm(
    const float* x_host,
    const float* weight_host,
    float* out_host,
    int32_t rows,
    int32_t hidden_dim,
    float eps
) {
    if (!x_host || !weight_host || !out_host || rows <= 0 || hidden_dim <= 0) return -1;
    size_t x_bytes = (size_t)rows * (size_t)hidden_dim * sizeof(float);
    size_t w_bytes = (size_t)hidden_dim * sizeof(float);

    float *d_x = nullptr, *d_w = nullptr, *d_out = nullptr;
    if (cudaMalloc(&d_x, x_bytes) != cudaSuccess) return -2;
    if (cudaMalloc(&d_w, w_bytes) != cudaSuccess) { cudaFree(d_x); return -2; }
    if (cudaMalloc(&d_out, x_bytes) != cudaSuccess) { cudaFree(d_x); cudaFree(d_w); return -2; }

    cudaMemcpy(d_x, x_host, x_bytes, cudaMemcpyHostToDevice);
    cudaMemcpy(d_w, weight_host, w_bytes, cudaMemcpyHostToDevice);

    sov_rmsnorm_f32_kernel<<<rows, 256>>>(d_x, d_w, d_out, hidden_dim, eps);
    cudaMemcpy(out_host, d_out, x_bytes, cudaMemcpyDeviceToHost);

    cudaFree(d_x);
    cudaFree(d_w);
    cudaFree(d_out);
    return 0;
}

#ifdef SOV_CUDA_CLI_MAIN
int main(int argc, char** argv) {
    int quick = 0;
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--quick") == 0) quick = 1;
    }
    SovereignCudaTelemetry tel{};
    int rc = sov_cuda_scan_and_bench(&tel, quick);
    if (rc != 0) {
        std::printf("{\"ok\":false,\"code\":%d}\n", rc);
        return 1;
    }
    std::printf(
        "{\n"
        "  \"ok\": true,\n"
        "  \"device_id\": %d,\n"
        "  \"device_name\": \"%s\",\n"
        "  \"compute_capability\": \"sm_%d%d\",\n"
        "  \"sm_count\": %d,\n"
        "  \"cuda_runtime_version\": %d,\n"
        "  \"cuda_driver_version\": %d,\n"
        "  \"vram_total_mb\": %.2f,\n"
        "  \"vram_free_mb\": %.2f,\n"
        "  \"l2_cache_mb\": %.2f,\n"
        "  \"fp32_fma_gflops\": %.2f,\n"
        "  \"fp16_tensor_tflops\": %.2f,\n"
        "  \"gddr6x_bandwidth_gbps\": %.2f,\n"
        "  \"zero_copy_pinned_gbps\": %.2f\n"
        "}\n",
        tel.device_id,
        tel.device_name,
        tel.compute_major,
        tel.compute_minor,
        tel.sm_count,
        tel.cuda_runtime_version,
        tel.cuda_driver_version,
        (double)tel.vram_total_bytes / (1024.0 * 1024.0),
        (double)tel.vram_free_bytes / (1024.0 * 1024.0),
        (double)tel.l2_cache_bytes / (1024.0 * 1024.0),
        tel.fp32_fma_gflops,
        tel.fp16_tensor_tflops,
        tel.gddr6x_bandwidth_gbps,
        tel.zero_copy_pinned_gbps
    );
    return 0;
}
#endif
