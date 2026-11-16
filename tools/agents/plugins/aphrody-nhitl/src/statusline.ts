// Status line: nhitl · mode · model · agents · ctx%. Reads Claude Code's statusline JSON on stdin.
import { readFileSync } from "node:fs";
import { CLAUDE_DIR, readState } from "./lib.ts";

let d: any = {};
try {
  d = JSON.parse((await Bun.stdin.text()) || "{}");
} catch {}
const sid = String(d.session_id ?? "nosid");
let mode = readState<{ mode?: string }>("mode", sid, {}).mode || "";
if (!mode) {
  try {
    mode =
      JSON.parse(readFileSync(`${CLAUDE_DIR}/settings.json`, "utf8"))
        .permissions?.defaultMode ?? "default";
  } catch {
    mode = "?";
  }
}
const short: Record<string, string> = {
  bypassPermissions: "bypass",
  acceptEdits: "edits",
  dontAsk: "dontAsk",
  default: "manual",
  plan: "plan",
  auto: "auto",
};
const agents = Object.values(
  readState<Record<string, { sid: string; ts: number }>>("agents", "all", {}),
).filter((a) => a.ts > Date.now() - 6 * 3600_000);
const mine = agents.filter((a) => a.sid === sid).length;
const parts = [
  "nhitl",
  short[mode] ?? mode,
  d.model?.display_name ?? d.model?.id ?? "?",
  `agents ${mine}${agents.length > mine ? `/${agents.length}` : ""}`,
];
const pct = d.context_window?.used_percentage;
if (typeof pct === "number") parts.push(`ctx ${Math.round(pct)}%`);
process.stdout.write(parts.join(" · "));
