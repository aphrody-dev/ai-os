# Relais de @aphrody/ai-os (`src/relay`)

Relais local entre Claude Code et Gemini (gemini.google.com piloté par CDP, ou Gemini CLI), avec la flotte VPS et gcloud en lecture. Un seul processus bun, jeton porteur obligatoire, liaison 127.0.0.1.

| Surface      | Point d'accès                                                                                                 | Protocole                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Relais natif | `POST /rpc`, `WS /ws`, TCP `8791` (NDJSON, 1re ligne = jeton), TLS `8792` si `RELAY_TLS_CERT`/`RELAY_TLS_KEY` | JSON-RPC 2.0                                                                                                                  |
| MCP          | `POST /mcp`, `relay mcp-stdio` (stdio)                                                                        | Streamable HTTP, 2025-11-25 (`initialize`) et 2026-07-28 (`server/discover`, sans état)                                       |
| A2A          | `GET /.well-known/agent-card.json`, `POST /a2a` (en-tête `A2A-Version: 1.0`)                                  | A2A 1.0.1 : `SendMessage`, `SendStreamingMessage` (SSE), `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`              |
| ACP          | `relay acp` (stdio)                                                                                           | Agent Client Protocol v1 (schema-v1.31.0) : `session/new`, `session/load`, `session/list`, `session/prompt`, `session/cancel` |

Outils : `agent_run`, `memory_search`, `memory_add`, `skills_list`, `council`, `llm_models`, `llm_ask`, `gemini_ask`, `notebook_ask`, `workspace_ask`, `figma_ask`, `accounts_sync`, plus les outils agrégés (`<serveur>__<outil>`) des serveurs MCP utilisateur et de Stitch (https://stitch.googleapis.com/mcp, jeton OAuth gcloud) ;, `gemini_review`, `agy_ask` (Antigravity CLI), `claude_ask` (Claude Code headless, mode plan), `fleet_status` (alias ssh, unités tunnels/VPN/proxy), `claude_inventory`, `gcloud_accounts`.

## Mise en route (Windows)

```sh
bun src/relay/cli.ts login      # Chrome du relais visible : connexion Google (une fois, par l'utilisateur)
bun src/relay/cli.ts browser    # Chrome du relais sans interface (CDP 127.0.0.1:9333)
bun src/relay/cli.ts serve      # ou le service AphrodyRelay (native/relay-windows/install.ps1, artefact CI relay-service)
bun src/relay/cli.ts mcp-add    # Claude Code : serveur MCP « relay » (portée utilisateur)
bun src/relay/cli.ts ask "…"    # test
```

Linux : `device/fleet/prd/systemd/aphrody-relay.service (racine de src)` (unité utilisateur, Antigravity CLI `agy`).

Revue automatique : le hook `src/relay/hook.ts` (PostToolUse Bash, asynchrone, dans `~/.claude/settings.json`) soumet chaque `git commit` d'un dépôt de `SRC_ROOT` à `gemini_review` et archive le verdict dans `docs/reviews/auto/<sha>.md`. Revue de livrables à la demande : workflow `.claude/workflows/gemini-review.js` (racine de src).

Diagnostic des sélecteurs quand l'interface de Gemini change : `relay inspect`.
