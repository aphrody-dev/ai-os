// headersHelper of Claude Code's "relay" MCP server (tools/agents/toolchain.toml, headers_helper): prints
// the Authorization header carrying the relay's local token (user's private file), never written to
// ~/.claude.json or in argv. No interactive OAuth consent: the relay accepts its fixed token locally.
import { relayToken } from "./server.ts";

// Write expected before exit: an immediate process.exit() can truncate a pipe on Windows.
await Bun.write(
  Bun.stdout,
  JSON.stringify({ Authorization: `Bearer ${await relayToken()}` }),
);
process.exitCode = 0;
