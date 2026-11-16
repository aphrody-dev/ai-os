// Live Terminal tools exposed uniformly via MCP (/mcp + stdio), A2A (/a2a), and WebMCP (navigator.modelContext).
import { s } from "../llm/schema.ts";
import type { Tool } from "../relay/tools.ts";
import { discoverProfiles, sharedTermManager } from "./pty.ts";

const str = s.string;

export function createTermTools(manager = sharedTermManager()): Tool[] {
  return [
    {
      name: "term_profiles",
      description:
        "List available terminal shells, AI TUIs (OpenCode), and SSH fleet targets discovered on this machine.",
      inputSchema: s.object({}),
      readOnly: true,
      run: async () => discoverProfiles(),
    },
    {
      name: "term_list",
      description:
        "List active Aphrody WebGPU PTY panes, dimensions, alive status, and failed command count.",
      inputSchema: s.object({}),
      readOnly: true,
      run: async () => manager.list(),
    },
    {
      name: "term_spawn",
      description:
        "Spawn a new interactive PTY pane (e.g. niubash, pwsh, opencode, ssh:fr1).",
      inputSchema: s.object(
        {
          profile: str("Profile id from term_profiles"),
          cwd: str("Working directory"),
          cols: s.number("Columns (default 120)"),
          rows: s.number("Rows (default 34)"),
          theme: str("Palette slug (default aphrody-m3-dark)"),
        },
        ["profile", "cwd", "cols", "rows", "theme"],
      ),
      readOnly: false,
      run: async (a) => {
        const p = manager.spawn({
          profile: a.profile,
          cwd: a.cwd,
          cols: a.cols ? Number(a.cols) : undefined,
          rows: a.rows ? Number(a.rows) : undefined,
          theme: a.theme,
        });
        return p.summary();
      },
    },
    {
      name: "term_read",
      description:
        "Read visible text or scrollback history, cursor state, CWD, and recent OSC 133 blocks from a terminal pane.",
      inputSchema: s.object(
        {
          paneId: str("Pane id (defaults to active/first pane)"),
          scrollback: s.boolean("Include scrollback history rows"),
          maxLines: s.number("Maximum scrollback lines to return"),
        },
        ["paneId", "scrollback", "maxLines"],
      ),
      readOnly: true,
      run: async (a) => {
        const p = a.paneId ? manager.get(a.paneId) : manager.first();
        if (!p) throw new Error(`Pane not found: ${a.paneId ?? "none"}`);
        const meta = p.vterm.meta();
        const text = a.scrollback
          ? p.vterm.scrollbackText(
              Math.max(
                0,
                meta.scrollbackLen +
                  meta.rows -
                  Math.max(meta.rows, Number(a.maxLines ?? 200)),
              ),
              Math.max(meta.rows, Number(a.maxLines ?? 200)),
            )
          : p.vterm.text();
        return {
          summary: p.summary(),
          meta,
          text,
          blocks: p.vterm.blocks(),
        };
      },
    },
    {
      name: "term_blocks",
      description:
        "Inspect OSC 133 semantic command blocks and failing exit codes in a terminal pane.",
      inputSchema: s.object(
        {
          paneId: str("Pane id (defaults to active/first pane)"),
          onlyFailed: s.boolean("Filter only failed commands (exitCode != 0)"),
        },
        ["paneId", "onlyFailed"],
      ),
      readOnly: true,
      run: async (a) => {
        const p = a.paneId ? manager.get(a.paneId) : manager.first();
        if (!p) throw new Error(`Pane not found: ${a.paneId ?? "none"}`);
        const all = p.vterm.blocks();
        return a.onlyFailed ? all.filter((b) => b.failed) : all;
      },
    },
    {
      name: "term_send",
      description: "Write text or control keystrokes into an active PTY pane.",
      inputSchema: s.object(
        {
          data: str("Text or escape sequence to write"),
          paneId: str("Pane id (defaults to active/first pane)"),
          enter: s.boolean("Append carriage return to execute"),
        },
        ["paneId", "enter"],
      ),
      readOnly: false,
      run: async (a) => {
        const p = a.paneId ? manager.get(a.paneId) : manager.first();
        if (!p) throw new Error(`Pane not found: ${a.paneId ?? "none"}`);
        const payload = `${String(a.data ?? "")}${a.enter ? "\r" : ""}`;
        p.write(payload);
        return { ok: true, paneId: p.id, bytes: payload.length };
      },
    },
    {
      name: "term_resize",
      description: "Resize an active PTY pane.",
      inputSchema: s.object(
        {
          paneId: str("Pane id"),
          cols: s.number("New column count"),
          rows: s.number("New row count"),
        },
        ["paneId"],
      ),
      readOnly: false,
      run: async (a) => {
        const p = a.paneId ? manager.get(a.paneId) : manager.first();
        if (!p) throw new Error(`Pane not found: ${a.paneId ?? "none"}`);
        p.resize(Number(a.cols), Number(a.rows));
        return p.summary();
      },
    },
    {
      name: "term_close",
      description: "Close a terminal pane cleanly.",
      inputSchema: s.object({ paneId: str("Pane id") }),
      readOnly: false,
      run: async (a) => ({ closed: manager.close(String(a.paneId)) }),
    },
  ];
}

export const TERM_TOOLS: Tool[] = createTermTools();
