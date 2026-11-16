#ifndef APHRODY_MWG_H
#define APHRODY_MWG_H

/* Canonical C23/C11/C++23 ABI header for the Modern Web Guidance Pure-C LLVM Core:
 * - system/core/capi/c/mwg_core.c -> system/wck/native/mwg_capi.dll
 * Consumed by C, C++23, Rust (system/core/capi/src/mwg.rs), and Bun (bun:ffi).
 */

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#ifndef APHRODY_ABI_VERSION
#define APHRODY_ABI_VERSION 1u
#endif

#define APHRODY_MWG_ABI_VERSION 1u

#ifndef MWG_API
#  if defined(_WIN32) && defined(MWG_BUILD_SHARED)
#    define MWG_API __declspec(dllexport)
#  else
#    define MWG_API
#  endif
#endif

/**
 * Return the Modern Web Guidance C ABI version (APHRODY_MWG_ABI_VERSION).
 */
MWG_API uint32_t mwg_abi_version(void);

/**
 * Release a string returned by any mwg_* function. Null is a no-op.
 */
MWG_API void mwg_free(char *p);

/**
 * Static audit of an HTML document; returns heap-allocated JSON string.
 */
MWG_API char *mwg_audit_html_json(const char *html);

/**
 * Static audit of a CSS stylesheet; returns heap-allocated JSON string.
 */
MWG_API char *mwg_audit_css_json(const char *css);

/**
 * Static audit of a JS/TS source buffer; returns heap-allocated JSON string.
 */
MWG_API char *mwg_audit_js_json(const char *js);

/**
 * Parse MDX/Markdown frontmatter, headings, and code blocks; returns heap-allocated JSON string.
 */
MWG_API char *mwg_parse_mdx_json(const char *mdx);

/**
 * Lexical BM25-style search over a JSON corpus array [{id, title, text}]; returns top_k JSON results.
 */
MWG_API char *mwg_search_guidance_json(const char *query, const char *corpus_json, uint32_t top_k);

/**
 * Lookup Baseline and guidance metadata for a web feature ID; returns heap-allocated JSON string.
 */
MWG_API char *mwg_feature_lookup_json(const char *feature_id);

/**
 * Compute deterministic 64-bit FNV-1a hash of `len` bytes at `data`.
 */
MWG_API uint64_t mwg_hash64(const uint8_t *data, size_t len);

#ifdef __cplusplus
}
#endif

#endif /* APHRODY_MWG_H */
