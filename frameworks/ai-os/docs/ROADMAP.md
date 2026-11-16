# Roadmap

Done (2026-11-12)

- P0 architecture, mapping, ADR, legacy inventory.
- P1 bun + cargo + uv workspace, identity.toml, MIT/Apache, CI (windows-latest, ubuntu, native on prd); submodule `agent/` in src.
- P2 legacy imported; 4 MCP servers -> `src/relay` (MCP), 2 councils -> `core/council.ts`, 3 redactors -> `core/secrets.ts`; ai-triad, brain, pi-opencode deleted.
- P3 `src/core`: AI SDK loop, tools, SQLite FTS memory, SKILL.md creation; real run on Windows with Workers AI `@cf/openai/gpt-oss-120b` (read/write/memory/skill, 5 steps).
- Scheduler + HEARTBEAT.md heartbeat (`agent schedule`, `agent heartbeat`); Hermes skill linter, usage, stale/archive curation, `skill_view`.
- TUI on `@earendil-works/pi-tui` (`agent tui`), multi-turn sessions.
- Gateway (`agent gateway`, src/gateway): WebSocket sessions, OpenAI-compatible chat, A2A agent card + message/send, channel webhooks; skills hub (`agent skills search/install`, ClawHub + GitHub); native bash resolution from the windows-native patches; TUI e2e through ConPTY.
- Hermes bridge: frameworks/agent/context (Rust, same SQLite schema, pyo3 `agent_core` behind the `python` feature) + python/hermes_agent_memory (Hermes MemoryProvider `agent`, entry point hermes_agent.memory_providers). Verified on prd: TS writes, Python reads, and the reverse. Context fusion: weighted RRF with tuned weights, porter stemming.
- shenron-chat-v2 on prd restarted with --jinja: raw tool calls work, but the LoRA model does not drive the agent loop (it claims success without calling tools).
- CI green on windows-latest + ubuntu-latest.
- legacy/ dissolved and deleted (context7 + fact-check tools in research).
- `local:` provider verified against llama-server on prd (container auto-llm, model auto-extraction, --jinja) via ssh tunnel: read_file + write_file, 3 steps. shenron-chat-v2 (no --jinja) answers but emits no tool calls.
- Deep research: `agent research <outline.yaml>` (one subagent per item, batch_size, results/<item>.json, TS validator ported from the upstream validate_json.py, results fed to memory).

Next 2. Merge Windows-native patches from aphrody-labs/{openclaw,hermes-agent} branch `windows-native` (C:\aphrody\docs\agents\WINDOWS-NATIVE-PORT.md, commit 16eea3d) into gateway/sandbox ports. 3. Research: index results in a vector store (local ONNX embeddings), cross-item synthesis report, resume of partial runs. 4. Durable scheduler on Vercel Workflow / Cloudflare Agents schedule; Windows service for the heartbeat. 5. Gateway + channels via Chat SDK (OpenClaw channel config). 6. Web UI (AI SDK UI + AG-UI); A2A and ACP endpoints; MCP over HTTP. 7. Sandbox: AppContainer via windows-rs; Vercel/CF Sandbox remote. 8. Inference: llama.cpp + ONNX Runtime/DirectML crates (forks), weights store (HF hub -> blake3 CAS -> R2); `local:` provider against prd llama-server through the mesh. 9. pyo3 bridge (our cpython/uv); tree-sitter tools via src src/core (branch core/common-lib). 10. Remaining src AI code: apps/web, apps/yolo, <fr2-hostname>; desktop/mobile; Linux 7.x packaging; runtime-adapter deploy (branch hosting/portable).
