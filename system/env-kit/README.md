# `@aphrody/env-kit` — Monorepo Environment & Secret Architecture

<!-- catalog:begin unit -->
<!-- prettier-ignore-start -->
> Zero-dependency cross-language environment sharing, secret redaction, and editor/agent sync toolkit (Google Cloud IAM and billing live in @aphrody/google/gcp) for C:/aphrody

| Type | Path |
| :-- | :-- |
| Bun package | `system/env-kit` |

**Commands**

```sh
bun run --cwd system/env-kit check
bun run --cwd system/env-kit fmt
bun run --cwd system/env-kit fmt:check
bun run --cwd system/env-kit test
bun run --cwd system/env-kit doctor
bun run --cwd system/env-kit accounts
```

Part of Aphrody: [aphrody-labs/ay](../../README.md), [Catalog](../../docs/reference/catalog/package.md).
<!-- prettier-ignore-end -->
<!-- catalog:end -->

Zero-dependency cross-language environment loader, secret redaction guard, and unified editor/CLI credential synchronizer for `C:\aphrody`.

## Security Model

1. **Master Secret Vault (`C:\aphrody\.env`)**: Locked via Windows NTFS ACLs (`inheritance:r`, explicit Full Control strictly restricted to `$env:USERNAME`, `NT AUTHORITY\SYSTEM`, and `BUILTIN\Administrators`).
2. **Global Git Guard**: `C:\aphrody\.gitignore` and global `core.excludesFile` (`~/.gitignore_global`) block `.env`, `.env.*` (except `!.env.example`), `.dev.vars`, `*.pem`, `*.key`, and `.credentials.json` across every repository on the machine.
3. **Zero-Leakage Redaction**: Every language loader masks credentials (`SET [len=N]`) or `[REDACTED]` on `inspect`, `JSON.stringify`, `Debug`/`Display`, `repr()`, `fmt.Stringer`, and `__tostring`.

## CLI Usage (`env-kit`)

Installed at `~\.local\bin\env-kit.exe` (`env-kit.cmd` shim):

```powershell
env-kit doctor                       # Masked audit of all credentials, NTFS ACLs, and editors
env-kit accounts status [--json]     # 3-principal gcloud configs, rclone, and 10 org provider surfaces
env-kit accounts init-gcloud         # Idempotently configure ai-agent, owner, org-contact, sa-automation
env-kit accounts switch <principal>  # Switch active gcloud config (<ai|owner|org|sa>)
env-kit accounts iam-bindings        # Print idempotent IAM policy bindings for project aphrody (#<gcp-project-numbers>)
env-kit set <KEY> <VALUE>            # Propagate secret to C:\aphrody\.env + Windows User Env + OpenCode/Zed/Pi
env-kit nuget-set-key <API_KEY>      # Set NUGET_API_KEY across .env and Windows User Env
env-kit sync-editors                 # Sync OpenCode, Zed, and Pi provider & MCP configs
env-kit sync-gh                      # Sync active `gh auth token` into GITHUB_TOKEN & GH_TOKEN
env-kit dev-vars <workerDir>         # Generate gitignored .dev.vars for Cloudflare `wrangler dev`
env-kit vercel-env [dir] [--write]   # Export masked Vercel env summary or .env.local
env-kit exec -- <command> [args...]  # Run any binary with C:\aphrody\.env injected
```

## OS Secret Store (`env-kit secret`, `ay secret`)

Encrypted by the OS, one file per secret named after its environment variable (`system/env-kit/vault/src/sync-store.ts`, `@aphrody/env-kit/vault/sync`):

| Host       | Backend                                                                  | Directory                                                                    |
| :--------- | :----------------------------------------------------------------------- | :--------------------------------------------------------------------------- |
| Windows    | DPAPI current user (`CryptProtectData` via bun:ffi, application entropy) | `%LOCALAPPDATA%\aphrody\secrets\<NAME>.dpapi`                                |
| Linux root | `systemd-creds` (host key, TPM2 when present)                            | `/etc/credstore.encrypted/<NAME>` (read by `LoadCredentialEncrypted=<NAME>`) |
| Linux user | `systemd-creds --user` (systemd >= 256)                                  | `~/.config/credstore.encrypted/<NAME>`                                       |

```sh
<provider cli> | ay secret set NAME      # value on stdin only (refused from a terminal)
ay secret exec NAME [NAME...] -- cmd     # child gets the values in its env
ay secret pipe NAME -- cmd               # child gets the value on stdin
ay secret list | info | has NAME | rm NAME | import [KEY...]   # import: .env -> store, idempotent
```

There is no `get`: a stdout captured by an agent or a CI log is not a terminal, so nothing prints a value.
Library API for other tools (AI provider keys included): `secretSet`, `secretGet`, `secretList`,
`resolveSecret(name)` (store, then `process.env` / `.env`). `env-kit set` and `sync-gh` also write the store.

## Fleet Authentication (`env-kit auth`, `ay auth`)

`status`, `repair [--browser]`, `gh-secrets`, `tunnels`, `rotate cloudflare`.
Inventory in `device/deploy.toml` (`[nodes.*]`, `[auth.*]`).

## Multi-Language Loaders

| Language / Runtime            | Path                                                      | Native CLI Flag / Usage                                                  |
| :---------------------------- | :-------------------------------------------------------- | :----------------------------------------------------------------------- |
| **Bun v1.4.4 / TypeScript**   | `C:\aphrody\packages\env-kit\src\index.ts`                    | `bun --env-file=C:/aphrody/.env` or `loadMonorepoEnv({ service, required })` |
| **Rust 2024 (`aphrody-env`)** | `C:\aphrody\src\env` (`ay env` inspects a `.env` without printing values) | `aphrody_env::load_monorepo_env(LoadOptions::default())`                 |
| **Python 3.12+ / `uv`**       | `C:\aphrody\packages\env-kit\loaders\python\sovereign_env.py` | `uv run --env-file C:/aphrody/.env` or `sovereign_env.load_monorepo_env()`   |
| **C11 / C++23**               | `C:\aphrody\packages\env-kit\loaders\cpp\sovereign_env.hpp`   | `sovereign_env::load()` / `sovereign_env_load_file(NULL, 0)`             |
| **.NET 10/11 C#**             | `C:\aphrody\packages\env-kit\loaders\dotnet\SovereignEnv.cs`  | `Aphrody.EnvKit.SovereignEnv.Load()`                                     |
| **Go 1.24+**                  | `C:\aphrody\packages\env-kit\loaders\go\envkit.go`            | `envkit.Load()`                                                          |
| **Lua 5.1+ / LuaJIT**         | `C:\aphrody\packages\env-kit\loaders\lua\sovereign_env.lua`   | `require("sovereign_env").load()` (via `LUA_PATH`)                       |
| **PowerShell / POSIX**        | `C:\aphrody\packages\env-kit\loaders\shell\load-env.ps1`      | `. C:\aphrody\packages\env-kit\loaders\shell\load-env.ps1` / `. load-env.sh` |
