/*
 * sovereign_env.h — Header-only C11 loader for C:\aphrody\.env
 * Uses `_putenv_s` on Windows NT and `setenv` on POSIX without external dependencies.
 */
#ifndef SOVEREIGN_ENV_H
#define SOVEREIGN_ENV_H

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#define SOVEREIGN_DEFAULT_ENV_PATH "C:\\aphrody\\.env"
#else
#define SOVEREIGN_DEFAULT_ENV_PATH "/src/.env"
#endif

static inline int sovereign_env_set_var(const char *key, const char *val, int override_existing) {
    if (!key || !*key || !val) {
        return -1;
    }
    if (!override_existing) {
        const char *existing = getenv(key);
        if (existing != NULL && existing[0] != '\0') {
            return 0;
        }
    }
#if defined(_WIN32)
    return _putenv_s(key, val);
#else
    return setenv(key, val, override_existing ? 1 : 0);
#endif
}

static inline int sovereign_env_load_file(const char *env_path, int override_existing) {
    const char *target = (env_path && env_path[0] != '\0') ? env_path : SOVEREIGN_DEFAULT_ENV_PATH;
    FILE *fp = fopen(target, "rb");
    if (!fp) {
        return -1;
    }

    char line[8192];
    int count = 0;

    while (fgets(line, (int)sizeof(line), fp) != NULL) {
        char *p = line;
        while (*p && isspace((unsigned char)*p)) {
            p++;
        }
        if (*p == '\0' || *p == '#') {
            continue;
        }
        if (strncmp(p, "export ", 7) == 0) {
            p += 7;
            while (*p && isspace((unsigned char)*p)) {
                p++;
            }
        }

        char *eq = strchr(p, '=');
        if (!eq || eq == p) {
            continue;
        }

        *eq = '\0';
        char *key = p;
        char *key_end = eq - 1;
        while (key_end > key && isspace((unsigned char)*key_end)) {
            *key_end-- = '\0';
        }

        char *val = eq + 1;
        while (*val && (*val == ' ' || *val == '\t')) {
            val++;
        }

        size_t vlen = strlen(val);
        while (vlen > 0 && (val[vlen - 1] == '\n' || val[vlen - 1] == '\r')) {
            val[--vlen] = '\0';
        }

        char decoded[8192];
        size_t di = 0;

        if (val[0] == '"') {
            for (size_t i = 1; val[i] != '\0' && di + 1 < sizeof(decoded); ++i) {
                if (val[i] == '\\' && val[i + 1] != '\0') {
                    ++i;
                    if (val[i] == 'n') decoded[di++] = '\n';
                    else if (val[i] == 'r') decoded[di++] = '\r';
                    else if (val[i] == 't') decoded[di++] = '\t';
                    else decoded[di++] = val[i];
                } else if (val[i] == '"') {
                    break;
                } else {
                    decoded[di++] = val[i];
                }
            }
            decoded[di] = '\0';
        } else if (val[0] == '\'') {
            for (size_t i = 1; val[i] != '\0' && val[i] != '\'' && di + 1 < sizeof(decoded); ++i) {
                decoded[di++] = val[i];
            }
            decoded[di] = '\0';
        } else {
            for (size_t i = 0; val[i] != '\0' && di + 1 < sizeof(decoded); ++i) {
                if (val[i] == '#' && i > 0 && isspace((unsigned char)val[i - 1])) {
                    break;
                }
                decoded[di++] = val[i];
            }
            while (di > 0 && isspace((unsigned char)decoded[di - 1])) {
                --di;
            }
            decoded[di] = '\0';
        }

        if (decoded[0] != '\0' || override_existing) {
            if (sovereign_env_set_var(key, decoded, override_existing) == 0) {
                count++;
            }
        }
    }

    fclose(fp);
    return count;
}

/* Masked fingerprint helper: writes either "UNSET" or "SET [len=N]" into out_buf */
static inline void sovereign_env_mask_status(const char *key, char *out_buf, size_t out_cap) {
    if (!out_buf || out_cap == 0) return;
    const char *v = key ? getenv(key) : NULL;
    if (!v || v[0] == '\0') {
        snprintf(out_buf, out_cap, "UNSET");
    } else {
        snprintf(out_buf, out_cap, "SET [len=%zu]", strlen(v));
    }
}

#ifdef __cplusplus
}
#endif

#endif /* SOVEREIGN_ENV_H */
