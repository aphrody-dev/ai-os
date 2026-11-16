# `@aphrody/ai-triad`

<!-- catalog:begin unit -->

> Cross-AI CLI, TUI, GUI, OAuth 2.1/PKCE/Device-Code, MCP & Multi-Protocol Gateway across OpenAI Codex, Google Antigravity/Gemini, Anthropic Claude Code, OpenCode, Pi, and Zed

| Type        | Path                                |
| :---------- | :---------------------------------- |
| Bun package | `frameworks/ai-os/engines/ai-triad` |

**Commands**

```sh
bun run --cwd frameworks/ai-os/engines/ai-triad start
bun run --cwd frameworks/ai-os/engines/ai-triad sync
bun run --cwd frameworks/ai-os/engines/ai-triad docs
bun run --cwd frameworks/ai-os/engines/ai-triad doctor
bun run --cwd frameworks/ai-os/engines/ai-triad tui
bun run --cwd frameworks/ai-os/engines/ai-triad ci
bun run --cwd frameworks/ai-os/engines/ai-triad build
bun run --cwd frameworks/ai-os/engines/ai-triad fmt
```

Part of Aphrody: [aphrody-labs/ay](../../../../README.md), [Catalog](../../../../docs/reference/catalog/package.md).
<!-- catalog:end -->

Cross-AI CLI, TUI, WebGUI, OAuth 2.1 / PKCE / RFC 8628 Device Authorization, MCP `2025-03-26`, ACP v1, and Multi-Protocol Gateway uniting **OpenAI Codex (`codex`)**, **Google Antigravity (`agy` + `gemini`)**, **Anthropic Claude Code (`claude`)**, **OpenCode**, **Pi**, and **Zed** in pure **Bun v1.4.4**.

## Quick Commands

```sh
# TUI / Diagnostics Dashboard
triad doctor

# Redacted Cross-Auth & OAuth Readiness Matrix
triad auth-status

# Idempotently sync Codex, Claude Code, Antigravity, Gemini, OpenCode, and Zed configs
triad sync-configs

# Start HTTP + WebGUI + OpenAI (/v1/chat/completions, /v1/responses) + Anthropic (/v1/messages) + MCP (/mcp) server
triad serve --port 4319

# Run MCP 2025-03-26 server over stdio (wired into Claude, Codex, Antigravity, OpenCode, and Zed)
triad mcp-stdio

# Generate GitHub Actions, Sovereign Forge, PowerShell, and POSIX CI pipelines
triad ci-gen --out C:/aphrody/frameworks/ai-os/engines/ai-triad

# Regenerate live CLI --help corpus
triad capture-help
```

## Documentation Corpus

- [CLAUDE_CLI_HELP.md](./docs/CLAUDE_CLI_HELP.md)
- [CODEX_CLI_HELP.md](./docs/CODEX_CLI_HELP.md)
- [AGY_GEMINI_CLI_HELP.md](./docs/AGY_GEMINI_CLI_HELP.md)
- [CROSS_PROVIDER_ARCHITECTURE.md](./docs/CROSS_PROVIDER_ARCHITECTURE.md)
