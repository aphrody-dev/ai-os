# ai-os brain

One brain for Claude Code and agy (Antigravity CLI), owned by `@aphrody/ai-os`.

## Commands

- `ai-os brain absorb [--days N] [--dry-run]`: indexes into `~/.agent/memory.sqlite` (Context store, FTS5 + embeddings)
  every Claude memory file, prompt history per project, one digest per Claude session transcript, and agy conversation
  summaries plus user turns (`~/.gemini/antigravity*/conversation_summaries.db`). Files older than N days in
  `~/.claude/{projects,file-history,paste-cache,backups,shell-snapshots}` and `~/.gemini/antigravity-cli/{brain,conversations}`
  are zstd level 19 compressed (`Bun.zstdCompressSync`) into `~/.agent/brain.sqlite` and removed from disk.
- `ai-os brain sync`: writes the global `~/.claude/CLAUDE.md` and the memory index into a managed block of
  `~/.gemini/GEMINI.md`, sets Claude `permissions.defaultMode = bypassPermissions` and agy
  `toolPermission = artifactReviewPolicy = always-proceed`, prunes agy `trustedWorkspaces` to existing paths.
- `ai-os brain restore <path>`: writes compressed files back to their original location.

## State on 2026-11-13

- Indexed: 91 memories, 5 project histories, 305 Claude sessions, 496 agy conversations.
- Packed: 28,764 files, 1.59 GB to 529 MB. Files touched in the last 24 h stay on disk so live sessions can resume.
- Verified headless without approval: `agy -p ... --output-format json` and `claude -p ... --output-format json` both
  ran a shell write and returned success.
- agy config facts and sources: `docs/cli-reference/agy.md`; Claude Code: `docs/cli-reference/claude-code.md`.

## Session summary (2026-11-13, consolidation of the agent context)

- Goal: one brain and one no-human-in-the-loop setup for Claude Code and agy, owned by ai-os, with compressed storage.
- Done: `ai-os brain` (absorb, sync, restore), unit tests `test/brain.test.ts`; `~/.claude/projects` 426 MB to 112 MB
  (remaining files are the live sessions touched in the last 15 min); `~/.gemini/antigravity-cli/brain` 1.3 GB to 106 MB;
  blob store 616 MB with byte-verified packing.
- agy facts applied (sources in `docs/cli-reference/agy.md`): settings in `~/.gemini/antigravity-cli/settings.json`,
  `toolPermission` and `artifactReviewPolicy` = `always-proceed`, hooks in `~/.gemini/config/hooks.json`, MCP in
  `~/.gemini/config/mcp_config.json` (legacy copy merged), `trustedWorkspaces` 70 to 23 entries.
- Claude facts applied (`docs/cli-reference/claude-code.md`): `AGENTS.md` is only loaded without a `CLAUDE.md`, so
  `C:\aphrody\CLAUDE.md` now imports `@AGENTS.md` and `@.agents/SOUL.md`.
- Context compaction: memories 47 to 36 (duplicates of the global CLAUDE.md removed, fleet contradictions merged into
  `fleet-roles`), GEMINI.md 15 KB to 8 KB (legacy directives replaced by a pointer to AGENTS.md plus the synced block),
  project CLAUDE.md fleet roles aligned with the global rule (fr1 = builds, CI, training, heavy agents).
- Verified: `claude -p` and `agy -p` each ran a shell write headless with no approval prompt.
- Reviews: relay Gemini 8/20 then 13/20, fixes applied; third pass on gemini.google.com Carbon High returned an empty answer twice, see
  `frameworks/ai-os/docs/reviews/brain-gemini.md`.
- agy hooks: both hooks.json files carried a UTF-8 BOM and were silently ignored (a test write reached System32). BOM removed, matcher updated to current tool names (run_command, write_to_file, replace_file_content, multi_replace_file_content); a probe hook captured the real PreToolUse payload and pre-tool-guard denies a System32 write with it. MCP: `agy mcp list` shows ai-os and hostinger, and a headless call to an ai-os tool succeeded.
