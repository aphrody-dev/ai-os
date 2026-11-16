#ifndef APHRODY_ZIG_H
#define APHRODY_ZIG_H

/* Canonical C23/C11/C++23 ABI header for the monorepo Zig cores:
 * - third_party/native (`libnative_sdk` / `native_sdk_app_*`)
 * - packages/browser of aphrody-labs/open (`browser_capi`)
 * Consumed by C, C++23, Rust (`system/core/capi`), and Bun (`bun:ffi`).
 */

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define APHRODY_ABI_VERSION 1u
#define APHRODY_STATUS_OK 0
#define APHRODY_STATUS_ERR 1
#define APHRODY_STATUS_INVALID_ARG (-1)

/* --- Native SDK Zig Core (`native`) --- */
void *native_sdk_app_create(void);
void native_sdk_app_destroy(void *app);

#ifdef __cplusplus
}
#endif

#endif /* APHRODY_ZIG_H */
