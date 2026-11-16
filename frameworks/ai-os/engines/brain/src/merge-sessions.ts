// Merge all AGY CLI sessions into a redacted Obsidian-compatible "brain" vault.
// Read-only on sessions; writes only under C:/aphrody/var/brain.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";

const BRAIN = "%USERPROFILE%/.gemini/antigravity-cli/brain";
const VAULT = "C:/aphrody/var/brain";
mkdirSync(`${VAULT}/Sessions`, { recursive: true });
mkdirSync(`${VAULT}/.obsidian`, { recursive: true });

// Redaction: exact secret values from C:/aphrody/.env (in memory only) + generic token patterns.
const secrets: string[] = [];
if (existsSync("C:/aphrody/.env")) {
  for (const l of readFileSync("C:/aphrody/.env", "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const v = m[2]!.replace(/^['"]|['"]$/g, "");
    if (
      v.length >= 12 &&
      !/^[A-Za-z]:[\\/]/.test(v) &&
      !/^https?:\/\/[^@]*$/.test(v)
    )
      secrets.push(v);
  }
}
secrets.sort((a, b) => b.length - a.length);
const patterns: [RegExp, string][] = [
  [/figd_[A-Za-z0-9_-]{20,}/g, "[REDACTED_FIGMA]"],
  [/(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB]"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_KEY]"],
  [/AIza[0-9A-Za-z_-]{30,}/g, "[REDACTED_GOOGLE]"],
  [/ya29\.[A-Za-z0-9._-]{20,}/g, "[REDACTED_GOOGLE_OAUTH]"],
  [/1\/\/[A-Za-z0-9._-]{20,}/g, "[REDACTED_GOOGLE_REFRESH]"],
  [/ctx7sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_CTX7]"],
  [/npm_[A-Za-z0-9]{30,}/g, "[REDACTED_NPM]"],
  [/(Bearer\s+)[A-Za-z0-9._-]{24,}/g, "$1[REDACTED]"],
  [
    /[\u{1F300}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
    "",
  ],
];
function redact(s: string): string {
  let out = s;
  for (const v of secrets)
    if (out.includes(v)) out = out.split(v).join("[REDACTED_ENV]");
  for (const [re, rep] of patterns) out = out.replace(re, rep);
  return out;
}
const clean = (s: unknown, n: number) =>
  redact(String(s ?? ""))
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<\/?USER_REQUEST>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);
const unq = (v: unknown) => {
  let s = String(v ?? "");
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      s = JSON.parse(s);
    } catch {
      s = s.slice(1, -1);
    }
  }
  return s.replace(/\\\\/g, "\\");
};

interface Row {
  id: string;
  start: string;
  end: string;
  steps: number;
  users: string[];
  files: string[];
  subagents: string[];
  toolErrors: number;
  finalText: string;
  status: string;
  quota429: boolean;
}
const rows: Row[] = [];
for (const id of readdirSync(BRAIN)) {
  const p = `${BRAIN}/${id}/.system_generated/logs/transcript.jsonl`;
  if (!existsSync(p)) continue;
  const lines = readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
  const files = new Set<string>();
  const subs: string[] = [];
  const users: string[] = [];
  let start = "",
    end = "",
    toolErrors = 0,
    finalText = "",
    lastModel: any = null,
    lastStep: any = null,
    quota = false;
  for (const l of lines) {
    let o: any;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    start ||= o.created_at ?? "";
    end = o.created_at ?? end;
    lastStep = o;
    if (o.type === "USER_INPUT") users.push(clean(o.content, 1500));
    if (o.status === "ERROR") toolErrors++;
    if (/RESOURCE_EXHAUSTED|code 429/.test(String(o.content ?? "")))
      quota = true;
    if (o.source === "MODEL" && o.type === "PLANNER_RESPONSE") lastModel = o;
    for (const tc of o.tool_calls ?? []) {
      const a = tc.args ?? {};
      if (/write_file|edit_file/.test(tc.name)) {
        const f = unq(a.Path);
        if (f) files.add(f);
      }
      if (tc.name === "invoke_subagent")
        subs.push(clean(unq(a.Role) || unq(a.TypeName), 80));
    }
  }
  if (lastModel && !lastModel.tool_calls?.length)
    finalText = clean(lastModel.content, 1200);
  const endedWithAnswer = Boolean(finalText) && lastStep === lastModel;
  const status = quota
    ? "stopped-quota-429"
    : endedWithAnswer
      ? "completed"
      : lastStep?.type === "USER_INPUT"
        ? "stopped-awaiting-reply"
        : "interrupted";
  rows.push({
    id,
    start,
    end,
    steps: lines.length,
    users,
    files: [...files],
    subagents: subs,
    toolErrors,
    finalText,
    status,
    quota429: quota,
  });
}
rows.sort((a, b) => a.start.localeCompare(b.start));

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "session";
const links: string[] = [];
for (const r of rows) {
  const title = r.users[0]
    ? slug(r.users[0].replace(/^\/goal\s*/, ""))
    : "subagent";
  const name = `${r.start.slice(0, 10)}-${r.id.slice(0, 8)}-${title}`;
  const body = [
    "---",
    `session_id: ${r.id}`,
    `status: ${r.status}`,
    `started: ${r.start}`,
    `ended: ${r.end}`,
    `steps: ${r.steps}`,
    `tool_errors: ${r.toolErrors}`,
    "tags: [agy-session]",
    "---",
    `# Session ${r.id.slice(0, 8)} (${r.status})`,
    "",
    "## User requests",
    ...(r.users.length
      ? r.users.map((u, i) => `${i + 1}. ${u}`)
      : ["(subagent session: task delivered by a parent session)"]),
    "",
    "## Outcome",
    r.finalText || `No final answer recorded. Last activity ${r.end}.`,
    "",
    `## Subagents spawned (${r.subagents.length})`,
    ...r.subagents.map((s) => `- ${s}`),
    "",
    `## Files written or edited (${r.files.length})`,
    ...r.files.slice(0, 60).map((f) => `- \`${f}\``),
    r.files.length > 60 ? `- ... and ${r.files.length - 60} more` : "",
    "",
  ].join("\n");
  writeFileSync(`${VAULT}/Sessions/${name}.md`, body);
  links.push(
    `- [[Sessions/${name}|${r.id.slice(0, 8)}]] ${r.status} - ${r.start.slice(0, 16)} - ${r.steps} steps - ${r.users[0] ? r.users[0].slice(0, 80) : "(subagent)"}`,
  );
}

const stopped = rows.filter(
  (r) => r.status !== "completed" && r.users.length > 0,
);
const stoppedSub = rows.filter(
  (r) => r.status !== "completed" && r.users.length === 0,
);
const stoppedMd = [
  "# Stopped sessions and what remains",
  "",
  "Top-level sessions that did not end with a final answer (mostly interrupted by the 429 quota exhaustion at 22:42Z on 2026-11-10).",
  "",
  ...stopped.map(
    (r) =>
      `## ${r.id.slice(0, 8)} - ${r.status}\n- Goal: ${r.users[0]?.replace(/^\/goal\s*/, "").slice(0, 400)}\n- Last activity: ${r.end}\n- Files touched: ${r.files.length}\n- Resume: re-issue the goal, the work already on disk is listed in [[Sessions/${r.start.slice(0, 10)}-${r.id.slice(0, 8)}-${r.users[0] ? slug(r.users[0].replace(/^\/goal\s*/, "")) : "subagent"}]]\n`,
  ),
  "## Subagent sessions that stopped",
  ...stoppedSub.map((r) => `- ${r.id.slice(0, 8)} ${r.status} (last ${r.end})`),
  "",
].join("\n");
writeFileSync(`${VAULT}/Stopped Sessions.md`, stoppedMd);

const counts = rows.reduce<Record<string, number>>(
  (m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m),
  {},
);
writeFileSync(
  `${VAULT}/00 Index.md`,
  [
    "# Aphrody brain index",
    "",
    `Generated ${new Date().toISOString()} from ${rows.length} AGY CLI sessions. Secrets are redacted (exact values from the vault file and common token patterns).`,
    "",
    "## Status counts",
    ...Object.entries(counts).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "- [[Stopped Sessions]]",
    "- Code knowledge graph: see `graphify-out/` (generated by graphify)",
    "",
    "## All sessions",
    ...links,
    "",
  ].join("\n"),
);
writeFileSync(
  `${VAULT}/.obsidian/app.json`,
  JSON.stringify({ alwaysUpdateLinks: true, newFileLocation: "root" }, null, 2),
);
writeFileSync(
  `${VAULT}/sessions.json`,
  JSON.stringify(
    rows.map(({ users, finalText, ...r }) => ({
      ...r,
      firstUser: users[0]?.slice(0, 200),
    })),
    null,
    2,
  ),
);
console.log("sessions merged:", rows.length, counts);
console.log(
  "stopped top-level:",
  stopped.map((r) => r.id.slice(0, 8)).join(", "),
);
console.log("redaction values loaded:", secrets.length);
