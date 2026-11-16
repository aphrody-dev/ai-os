// NHITL scanners: each returns reproducible Violation[] (id = fingerprint of source + location + rule).
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { hosts as fleetHosts, shq, srcRoot } from "../orch/fleet";
import {
  fingerprint,
  type Index,
  redact,
  type Severity,
  type Status,
  type Violation,
} from "./index";
import { expandSync } from "../../../../system/env-kit/src/discover.ts";

const HOME = homedir();
const claudeDir = () => Bun.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude");

// ---------------------------------------------------------------- transcripts
/** End of an assistant turn that hands control back to a human. Order = priority (one category per message). */
export const TAIL_RULES: {
  category: string;
  severity: Severity;
  re: RegExp;
  fix: string;
}[] = [
  {
    category: "passive_wait",
    severity: "high",
    re: /\b(j'attends|j’attends|en attente (de|du|d'une|d’une) (ta|ton|votre|vos|validation|confirmation|réponse|retour|feu vert|propriétaire)|je patiente|waiting for (you|your)|awaiting (your|confirmation))\b/i,
    fix: "Never wait: carry on with the rest to do, record the blocker in the NHITL index and continue.",
  },
  {
    category: "owner_todo",
    severity: "high",
    re: /(reste (à faire )?(au|pour le|côté) propriétaire|de ton côté|à toi de|il te (reste|faut)|tu (dois|devras|peux) (lancer|cliquer|exécuter|ouvrir|saisir|coller|valider)|ce qui reste au propriétaire|action (manuelle|requise)|you('ll)? need to|on your side|manual step)/i,
    fix: "Do each item yourself (non-interactive CLI, secret storage, claude-in-chrome); otherwise an index entry with the cause.",
  },
  {
    category: "conditional_offer",
    severity: "medium",
    re: /(si tu (le )?(veux|souhaites|préfères)|si vous (le )?(voulez|souhaitez)|veux-tu|voulez-vous|souhaites-tu|dis[- ]moi|dites[- ]moi|\bdis\s+[«"`“]|want me to|shall i|should i|let me know|if you('d)? (want|like|prefer))/i,
    fix: "Do not propose: run the most likely option, then report.",
  },
  {
    category: "final_question",
    severity: "medium",
    re: /\?\s*[*_`)\]»"”]*\s*$/,
    fix: "Decide instead of asking (CLAUDE.md: no question or confirmation).",
  },
];

export function classifyTail(text: string) {
  const tail = text.slice(-600);
  const last = tail.trim().split(/\n+/).slice(-6).join("\n");
  for (const r of TAIL_RULES)
    if (r.re.test(r.category === "final_question" ? text.trimEnd() : last))
      return r;
  return undefined;
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((c: any) => c?.type === "text" && typeof c.text === "string")
          .map((c: any) => c.text)
          .join("\n")
      : "";

/** Claude Code transcripts: last text message of each turn of the main agent (not the sub-agents). */
export function scanTranscripts(ix: Index) {
  const root = join(claudeDir(), "projects");
  const items: Violation[] = [];
  const keep: string[] = [];
  const stamps: Record<string, string> = {};
  if (!existsSync(root)) return { items, keep, stamps };
  for (const proj of readdirSync(root)) {
    const dir = join(root, proj);
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      const unit = `${proj}/${f}`;
      const st = statSync(path);
      const stamp = `${st.size}:${st.mtimeMs}`;
      if (ix.stamp(unit) === stamp) {
        keep.push(...ix.idsOf("transcript", unit));
        continue;
      }
      stamps[unit] = stamp;
      let text = "";
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      tailsOf(unit, text, items);
    }
  }
  // Cold transcripts compressed by `ai-os brain` in <AGENT_HOME>/brain.sqlite (blobs table, zstd).
  const brain = join(
    Bun.env.AGENT_HOME ?? join(HOME, ".agent"),
    "brain.sqlite",
  );
  if (existsSync(brain)) {
    let db: Database | undefined;
    try {
      db = new Database(brain, { readonly: true });
      const rows = db
        .query("SELECT path, mtime, size FROM blobs WHERE path LIKE ?")
        .all("%projects%.jsonl") as {
        path: string;
        mtime: number;
        size: number;
      }[];
      for (const r of rows) {
        const parts = r.path.replaceAll("\\", "/").split("/");
        if (parts.length < 4 || parts.at(-3) !== "projects") continue; // <projet>/<session>.jsonl seulement
        const unit = `${parts.at(-2)}/${parts.at(-1)}`;
        const stamp = `brain:${r.size}:${r.mtime}`;
        if (ix.stamp(unit) === stamp) {
          keep.push(...ix.idsOf("transcript", unit));
          continue;
        }
        stamps[unit] = stamp;
        const blob = db
          .query("SELECT data FROM blobs WHERE path = ?")
          .get(r.path) as { data: Uint8Array } | null;
        if (blob)
          tailsOf(
            unit,
            new TextDecoder().decode(Bun.zstdDecompressSync(blob.data)),
            items,
          );
      }
    } catch (e) {
      console.error(`brain.sqlite illisible : ${(e as Error).message}`);
    } finally {
      db?.close();
    }
  }
  return { items, keep, stamps };
}

/** Turns of the main agent in a transcript that hand control back. */
function tailsOf(unit: string, text: string, items: Violation[]) {
  for (const line of text.split("\n")) {
    if (!line.includes('"end_turn"') || !line.includes('"role":"assistant"'))
      continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.isSidechain || j.message?.stop_reason !== "end_turn") continue;
    const body = textOf(j.message?.content);
    if (!body) continue;
    const r = classifyTail(body);
    if (!r) continue;
    items.push({
      id: fingerprint("transcript", unit, j.uuid ?? ""),
      source: "transcript",
      location: `${unit}#${j.timestamp ?? j.uuid}`,
      category: r.category,
      severity: r.severity,
      excerpt: redact(body.slice(-140), 140),
      fix: r.fix,
      status: "open",
      unit,
    });
  }
}

// ---------------------------------------------------------------- settings
const jsonc = (p: string): any => {
  try {
    const t = readFileSync(p, "utf8")
      .replace(/^\uFEFF/, "")
      .replace(
        /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
        (_m, s) => s ?? "",
      )
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** Intended guardrails: protection of secrets and of the system, never lifted (inevitable status). */
const GUARD =
  /\.env|System32|credstore|secrets?|\.ssh|id_ed25519|rm -rf \/|force|--no-verify|IS_SANDBOX/i;

function claudeSettingsFiles(): string[] {
  const out = new Set<string>();
  const add = (dir: string) => {
    for (const n of ["settings.json", "settings.local.json"]) {
      const p = join(dir, n);
      if (existsSync(p)) out.add(p);
    }
  };
  add(claudeDir());
  add(join(srcRoot(), ".claude"));
  const cfg = jsonc(join(HOME, ".claude.json"));
  for (const p of Object.keys(cfg?.projects ?? {})) add(join(p, ".claude"));
  return [...out];
}

export function scanSettings(): Violation[] {
  const out: Violation[] = [];
  const v = (
    file: string,
    key: string,
    category: string,
    severity: Severity,
    excerpt: string,
    fix: string,
    status: Status = "open",
    reason?: string,
  ) =>
    out.push({
      id: fingerprint("settings", file, key),
      source: "settings",
      location: `${file}:${key}`,
      category,
      severity,
      excerpt: redact(excerpt),
      fix,
      status,
      reason,
    });
  for (const f of claudeSettingsFiles()) {
    const j = jsonc(f);
    const p = j?.permissions ?? {};
    for (const rule of p.deny ?? []) {
      const guard = GUARD.test(rule);
      v(
        f,
        `deny:${rule}`,
        "settings_deny",
        guard ? "info" : "low",
        `deny ${rule}`,
        guard
          ? "Keep: secret or system guardrail."
          : "Remove the rule or provide an equivalent non-interactive path.",
        guard ? "inevitable" : "open",
        guard ? "security guardrail (secret, system, git history)" : undefined,
      );
    }
    for (const rule of p.ask ?? [])
      v(
        f,
        `ask:${rule}`,
        "settings_confirm",
        "high",
        `ask ${rule}`,
        "Turn the rule into allow (or deny if dangerous): an ask rule blocks headless sessions.",
      );
    if (p.defaultMode && p.defaultMode !== "bypassPermissions")
      v(
        f,
        `defaultMode:${p.defaultMode}`,
        "settings_confirm",
        "medium",
        `defaultMode ${p.defaultMode}`,
        "defaultMode bypassPermissions in ~/.claude/settings.json (project settings do not honor it).",
        f.startsWith(claudeDir()) ? "open" : "inevitable",
        f.startsWith(claudeDir())
          ? undefined
          : "project setting: bypass imposed by the user settings",
      );
    if (p.disableBypassPermissionsMode)
      v(
        f,
        "disableBypassPermissionsMode",
        "settings_confirm",
        "high",
        "disableBypassPermissionsMode",
        "Retirer disableBypassPermissionsMode.",
      );
  }
  // Antigravity (agy) : CLI et IDE.
  const agyCli = join(HOME, ".gemini", "antigravity-cli", "settings.json");
  const a = jsonc(agyCli);
  if (a) {
    if (a.toolPermission && a.toolPermission !== "always-proceed")
      v(
        agyCli,
        "toolPermission",
        "settings_confirm",
        "high",
        `toolPermission ${a.toolPermission}`,
        'toolPermission "always-proceed".',
      );
    if (
      a.artifactReviewPolicy &&
      !/agent-decides|always-proceed/.test(a.artifactReviewPolicy)
    )
      v(
        agyCli,
        "artifactReviewPolicy",
        "settings_confirm",
        "medium",
        `artifactReviewPolicy ${a.artifactReviewPolicy}`,
        'artifactReviewPolicy "agent-decides".',
      );
  }
  const agyCfg = join(HOME, ".gemini", "config", "config.json");
  const c = jsonc(agyCfg);
  if (c) {
    const want: Record<string, RegExp> = {
      autoExecutionPolicy: /EAGER|TURBO|ALWAYS/,
      permissionPreset: /TURBO/,
      artifactReviewMode: /TURBO/,
      browserJsExecutionPolicy: /TURBO|ALWAYS/,
      nonWorkspaceFileAccessPolicy: /ALLOW/,
    };
    const walk = (o: any, path: string) => {
      if (!o || typeof o !== "object") return;
      for (const [k, val] of Object.entries(o)) {
        if (typeof val === "string" && want[k] && !want[k]!.test(val))
          v(
            agyCfg,
            `${path}${k}`,
            "settings_confirm",
            "high",
            `${k} ${val}`,
            `${k} in no-confirmation mode (${want[k]!.source}).`,
          );
        else if (typeof val === "object") walk(val, `${path}${k}.`);
      }
    };
    walk(c, "");
  }
  // opencode : permission.{edit,bash,webfetch,...} = ask | deny.
  for (const f of ["opencode.jsonc", "opencode.json"].map((n) =>
    join(Bun.env.XDG_CONFIG_HOME ?? join(HOME, ".config"), "opencode", n),
  )) {
    const o = jsonc(f);
    const walk = (x: any, path: string) => {
      if (typeof x === "string") {
        if (x === "ask")
          v(
            f,
            path,
            "settings_confirm",
            "high",
            `${path} ask`,
            `${path} = "allow" (ou "deny").`,
          );
        else if (x === "deny")
          v(
            f,
            path,
            "settings_deny",
            GUARD.test(path) ? "info" : "low",
            `${path} deny`,
            "Check that the denial is an intended guardrail.",
            GUARD.test(path) ? "inevitable" : "open",
            GUARD.test(path) ? "security guardrail" : undefined,
          );
      } else if (x && typeof x === "object")
        for (const [k, val] of Object.entries(x)) walk(val, `${path}.${k}`);
    };
    if (o?.permission) walk(o.permission, "permission");
    for (const [name, ag] of Object.entries<any>(o?.agent ?? {}))
      if (ag?.permission) walk(ag.permission, `agent.${name}.permission`);
  }
  return out;
}

// ---------------------------------------------------------------- code
type CodeRule = {
  category: string;
  severity: Severity;
  pattern: string;
  glob: string[];
  fix: string;
  status?: Status;
  reason?: string;
  /** Line ignored if it matches (non-interactive form already present). */
  unless?: RegExp;
};

export const CODE_RULES: CodeRule[] = [
  {
    category: "interactive_prompt",
    severity: "high",
    pattern: String.raw`(?<![\w.$])(prompt|confirm)\(\s*["'\x60]`,
    glob: ["*.{ts,tsx,js,mjs,cjs}"],
    fix: "Read the value from an argument, an environment variable or secret storage; never a prompt.",
  },
  {
    category: "interactive_prompt",
    severity: "high",
    pattern: String.raw`\b(Read-Host|Get-Credential)\b`,
    glob: ["*.{ps1,psm1}"],
    fix: "Mandatory parameter or secret read by `ay secret exec`, never Read-Host/Get-Credential.",
  },
  {
    category: "interactive_prompt",
    severity: "high",
    pattern: String.raw`\b(rl|readline|iface|reader)\.question\(|createInterface\(\s*\{\s*input:\s*process\.stdin`,
    glob: ["*.{ts,tsx,js,mjs}"],
    fix: "Ne pas attendre stdin : argument, variable d'environnement ou `--yes`.",
  },
  {
    category: "interactive_prompt",
    severity: "high",
    pattern: String.raw`(?<![\w.])input\(`,
    glob: ["*.py"],
    fix: "argparse/env au lieu de input().",
  },
  {
    category: "interactive_prompt",
    severity: "medium",
    pattern: String.raw`--interactive\b|\bread -r?p\b|\bread -s\b`,
    glob: ["*.{sh,bash,ts,js,ps1,toml,yml,yaml}", "justfile", "Dockerfile*"],
    fix: "Variante non interactive (--yes, --non-interactive, stdin d'un secret).",
    unless: /--non-interactive|--no-interactive/,
  },
  {
    category: "owner_approval",
    severity: "medium",
    pattern: String.raw`approval["']?\s*[:=]\s*["']owner["']|owner-rules`,
    glob: ["*.{ts,json,toml,md}"],
    fix: "Allow the effect in .agents/owner-rules.json when it is reversible; otherwise a draft held in the outbox (inevitable: publication, sending, spending).",
  },
  {
    category: "endless_wait",
    severity: "medium",
    pattern: String.raw`sleep infinity|tail -f /dev/null|Bun\.sleep\(\s*Infinity|while\s*\(\s*true\s*\)\s*\{\s*await\s+Bun\.sleep|while true; do sleep`,
    glob: ["*.{ts,js,sh,bash,ps1,yml,yaml}", "Dockerfile*", "justfile"],
    fix: "Bounded wait (timeout) or event (file, socket, systemd) instead of an endless loop.",
  },
  {
    category: "browser_login",
    severity: "high",
    pattern: String.raw`\b(gh auth login|npm login|gcloud auth login|wrangler login|vercel login|codex login|claude auth login|az login|docker login)\b`,
    glob: ["*.{ts,js,sh,bash,ps1,toml,yml,yaml}", "justfile"],
    fix: "Long-lived token drawn from secret storage: gh --with-token, npm token, gcloud service account, codex --with-api-key, claude setup-token, docker --password-stdin.",
    unless:
      /--with-token|--with-api-key|--password-stdin|--cred-file|--no-launch-browser/,
  },
  {
    category: "missing_noninteractive",
    severity: "medium",
    pattern: String.raw`\b(apt-get|apt|dnf|yum) (install|upgrade)\b|\bpacman -S\b|\bclaude\s+["'$]`,
    glob: ["*.{sh,bash,ts,yml,yaml}", "Dockerfile*", "justfile"],
    fix: "Mode non interactif explicite (-y, --noconfirm, claude -p).",
    unless: /\s-y\b|--yes|--noconfirm|DEBIAN_FRONTEND|claude\s+-p\b|--print\b/,
  },
];

const CODE_EXCLUDE = [
  "!third_party/**",
  "!**/node_modules/**",
  "!var/**",
  "!target/**",
  "!graphify-out/**",
  "!**/*.test.*",
  "!**/test/**",
  "!**/tests/**",
  "!**/fixtures/**",
  "!frameworks/ai-os/src/nhitl/**",
  "!docs/**",
  "!**/*.md",
];

const rg = () => Bun.which("rg") ?? "rg";

export async function scanCode(root = srcRoot()): Promise<Violation[]> {
  const out: Violation[] = [];
  await Promise.all(
    CODE_RULES.map(async (r, i) => {
      const args = [
        rg(),
        "--pcre2",
        "-n",
        "--no-heading",
        "--with-filename",
        "--max-columns",
        "300",
        "--max-filesize",
        "2M",
        ...r.glob.flatMap((g) => ["-g", g]),
        ...CODE_EXCLUDE.flatMap((g) => ["-g", g]),
        "-e",
        r.pattern,
        ".",
      ];
      const p = Bun.spawn(args, {
        cwd: root,
        stdout: "pipe",
        stderr: "ignore",
      });
      const text = await new Response(p.stdout).text();
      await p.exited;
      for (const line of text.split("\n")) {
        const m = /^(.+?):(\d+):(.*)$/.exec(line);
        if (!m) continue;
        const [, file, ln, code] = m;
        if (r.unless?.test(code!)) continue;
        const rel = file!.replace(/^\.[\\/]/, "").replaceAll("\\", "/");
        // Confirmation box of a web page: meant for the site's end user, not for an agent.
        const ui =
          r.category === "interactive_prompt" && /\.(tsx|jsx)$/.test(rel);
        out.push({
          id: fingerprint("code", rel, String(i), code!.trim()),
          source: "code",
          location: `${rel}:${ln}`,
          category: r.category,
          severity: ui ? "info" : r.severity,
          excerpt: redact(code!, 140),
          fix: r.fix,
          status: ui ? "inevitable" : (r.status ?? "open"),
          reason: ui
            ? "web interface confirmation for the end user, outside the agent loop"
            : r.reason,
        });
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------- docs
const DOC_RE = String.raw`(clic(s)? (du |final du )?propriétaire|le propriétaire (clique|saisit|colle|approuve|valide)|en attente du propriétaire|ce qui reste au propriétaire|reste au propriétaire|à la main|manuellement|invite UAC|owner (must|clicks|approves)|manual(ly)? (step|action|login))`;

export async function scanDocs(root = srcRoot()): Promise<Violation[]> {
  const p = Bun.spawn(
    [
      rg(),
      "-n",
      "-i",
      "--no-heading",
      "--with-filename",
      "--max-columns",
      "400",
      "-g",
      "*.md",
      "-g",
      "!third_party/**",
      "-g",
      "!**/node_modules/**",
      "-g",
      "!var/**",
      "-g",
      "!docs/archive/**",
      "-e",
      DOC_RE,
      ".",
    ],
    { cwd: root, stdout: "pipe", stderr: "ignore" },
  );
  const text = await new Response(p.stdout).text();
  await p.exited;
  const out: Violation[] = [];
  for (const line of text.split("\n")) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    const rel = m[1]!.replace(/^\.[\\/]/, "").replaceAll("\\", "/");
    const review = /^docs\/(reviews|proofs)\//.test(rel);
    out.push({
      id: fingerprint("docs", rel, m[3]!.trim()),
      source: "docs",
      location: `${rel}:${m[2]}`,
      category: "doc_manual_action",
      severity: review ? "info" : "medium",
      excerpt: redact(m[3]!, 160),
      fix: "Automate the step (just recipe, non-interactive CLI, secret from storage) then rewrite the doc; otherwise a registry entry with the cause.",
      status: review ? "inevitable" : "open",
      reason: review
        ? "archived report: dated finding, not modifiable"
        : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------- hook (denials of the aphrody-nhitl plugin)
export function scanHook(): Violation[] {
  const f = join(claudeDir(), "learning", "nhitl.jsonl");
  if (!existsSync(f)) return [];
  const counts = new Map<string, number>();
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.includes('"deny"') && !line.includes('"ask"')) continue;
    try {
      const j = JSON.parse(line);
      if (j.d !== "deny" && j.d !== "ask") continue;
      const k = `${j.d}:${j.tool ?? "?"}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    } catch {}
  }
  return [...counts].map(([k, n]) => ({
    id: fingerprint("hook", k),
    source: "hook" as const,
    location: `~/.claude/learning/nhitl.jsonl:${k}`,
    category: k.startsWith("ask") ? "hook_confirm" : "hook_deny",
    severity: (k.startsWith("ask") ? "high" : "low") as Severity,
    excerpt: `${n} ${k} decision(s)`,
    fix: "Review tools/agents/plugins/aphrody-nhitl/src/policy.ts: denials reserved for guardrails, never ask.",
    status: "open" as Status,
  }));
}

// ---------------------------------------------------------------- files d'agents
type Target = { host: string; ssh?: string[]; local?: string; dir?: string };

/** Queue hosts: fleet.toml (local pc, fr1, prd, fr2). ssh = targets tried in order, then hop. */
export function queueTargets(root = srcRoot()): Target[] {
  const fleet: any = existsSync(join(root, "tools/agents/fleet.toml"))
    ? Bun.TOML.parse(
        expandSync(readFileSync(join(root, "tools/agents/fleet.toml"), "utf8")),
      )
    : {};
  const out: Target[] = [];
  for (const h of fleetHosts(root)) {
    if (h.local) {
      out.push({
        host: h.id,
        local: Bun.env.AGENTS_HOME ?? join(h.src, "var", "agents"),
      });
      continue;
    }
    const raw: string[] = fleet.hosts?.[h.id]?.ssh ?? [h.ssh!];
    const pub = raw
      .map((t) => t.split("@").pop()!)
      .find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x) && !x.startsWith("10."));
    const jump = Bun.env.NHITL_JUMP ?? "fr2";
    const cmds = raw.map((t) => [t]);
    // WireGuard mesh closed from the PC: hop through fr2, host key verified under the known public IP.
    for (const t of raw.filter((t) => /@10\./.test(t)))
      if (h.id !== jump)
        cmds.push([
          "-J",
          jump,
          ...(pub ? ["-o", `HostKeyAlias=${pub}`] : []),
          t,
        ]);
    out.push({
      host: h.id,
      dir: `${h.src}/var/agents`,
      ssh: cmds.map((c) => c.join("\u0001")),
    });
  }
  return out;
}

const QUEUE_DUMP = (dir: string) =>
  `d=${shq(dir)}; for s in failed new outbox; do if [ "$s" = outbox ]; then for f in "$d"/outbox/*/*.json "$d"/outbox/*.md; do [ -f "$f" ] && printf '@@%s %s\\n' outbox "$f"; done; else for f in "$d"/queue/$s/*.json; do [ -f "$f" ] || continue; printf '@@%s %s\\n' $s "$f"; head -c 60000 "$f"; printf '\\n'; id=$(basename "$f" .json); [ -f "$d/results/$id/result.json" ] && { printf '@@result %s\\n' "$id"; head -c 20000 "$d/results/$id/result.json"; printf '\\n'; }; done; fi; done; true`;

async function dumpQueue(
  t: Target,
): Promise<{ text: string; via?: string; error?: string }> {
  if (t.local) {
    const sh =
      process.platform === "win32"
        ? (Bun.which("niu") ?? Bun.which("bash") ?? "sh")
        : "sh";
    const p = Bun.spawn([sh, "-c", QUEUE_DUMP(t.local.replaceAll("\\", "/"))], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return { text: await new Response(p.stdout).text(), via: "local" };
  }
  let last = "";
  for (const c of t.ssh ?? []) {
    const args = c.split("\u0001");
    const p = Bun.spawn(
      [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        ...args,
        QUEUE_DUMP(t.dir!),
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 90_000 },
    );
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code === 0) return { text: out, via: args.join(" ") };
    last = err.trim().split("\n").pop() ?? `exit ${code}`;
  }
  return { text: "", error: last || "no ssh target" };
}

const AUTH_RE =
  /auth|login|oauth|401|403|credential|token|unauthori[sz]ed|not logged|expired/i;

export function parseQueueDump(host: string, text: string): Violation[] {
  const out: Violation[] = [];
  const results = new Map<string, any>();
  const blocks = text.split(/^@@/m).filter(Boolean);
  for (const b of blocks) {
    const nl = b.indexOf("\n");
    const [kind, name] = (nl < 0 ? b : b.slice(0, nl)).split(" ");
    if (kind === "result")
      try {
        results.set(name!, JSON.parse(b.slice(nl + 1)));
      } catch {}
  }
  for (const b of blocks) {
    const nl = b.indexOf("\n");
    const [kind, path] = (nl < 0 ? b : b.slice(0, nl)).split(" ");
    if (kind === "outbox") {
      out.push({
        id: fingerprint("queue", host, path!),
        source: "queue",
        location: `${host}:${path}`,
        category: "held_effect",
        severity: "low",
        excerpt: `effet externe retenu : ${basename(path!)}`,
        fix: "Allow the effect in .agents/owner-rules.json if it is reversible; otherwise it stays held.",
        status: "inevitable",
        reason:
          "publication, sending or spending: owner decision by contract (owner-rules)",
        unit: host,
      });
      continue;
    }
    if (kind !== "failed" && kind !== "new") continue;
    let t: any;
    try {
      t = JSON.parse(b.slice(nl + 1));
    } catch {
      continue;
    }
    const r = results.get(t.id);
    const attempts: any[] = r?.attempts ?? t.attempts ?? [];
    const reasons = attempts.map((a) => a.reason).filter(Boolean);
    const unavailable = reasons.filter(
      (x) => x === "provider_unavailable",
    ).length;
    const errText = JSON.stringify(r ?? {}).slice(0, 4000);
    const authish = AUTH_RE.test(errText);
    if (kind === "new" && t.approval === "owner")
      out.push({
        id: fingerprint("queue", host, t.id, "approval"),
        source: "queue",
        location: `${host}:queue/new/${t.id}.json`,
        category: "owner_approval",
        severity: "medium",
        excerpt: `${t.role ?? "?"} task awaiting owner approval`,
        fix: "Reversible effect: owner-rules; otherwise draft in outbox, the queue continues.",
        status: "open",
        unit: host,
      });
    if (kind === "new" && !unavailable) continue;
    const category =
      kind === "failed"
        ? authish || unavailable
          ? "queue_failed_auth"
          : "queue_failed"
        : "queue_requeued_auth";
    out.push({
      id: fingerprint("queue", host, t.id, kind!),
      source: "queue",
      location: `${host}:queue/${kind}/${t.id}.json`,
      category,
      severity: category === "queue_failed" ? "medium" : "high",
      excerpt: redact(
        `${t.role ?? "?"}; attempts ${attempts.length} (${reasons.join(",") || "none"})${r?.commit?.error ? `; ${r.commit.error}` : ""}`,
      ),
      fix:
        category === "queue_failed"
          ? "Retry after the fix (just agents enqueue) or remove the task."
          : "Long-lived credential in the host's storage (systemd-creds --user: CLAUDE_CODE_OAUTH_TOKEN, GH_TOKEN), then requeue.",
      status: "open",
      unit: host,
    });
  }
  return out;
}

export async function scanQueues(
  onlyLocal = false,
): Promise<{ items: Violation[]; errors: Record<string, string> }> {
  const items: Violation[] = [];
  const errors: Record<string, string> = {};
  await Promise.all(
    queueTargets()
      .filter((t) => !onlyLocal || t.local)
      .map(async (t) => {
        const d = await dumpQueue(t);
        if (d.error) {
          errors[t.host] = d.error;
          items.push({
            id: fingerprint("queue", t.host, "unreachable"),
            source: "queue",
            location: `${t.host}:ssh`,
            category: "host_unreachable",
            severity: "medium",
            excerpt: redact(d.error),
            fix: "Restore ssh (load, firewall, key); the host's queue is not readable.",
            status: "open",
            unit: t.host,
          });
          return;
        }
        items.push(...parseQueueDump(t.host, d.text));
      }),
  );
  return { items, errors };
}

// ---------------------------------------------------------------- versioned registry (items surveyed by hand)
export function scanLedger(root = srcRoot()): Violation[] {
  const f = join(root, "frameworks/ai-os/src/nhitl/ledger.json");
  const j = jsonc(f) as { entries?: any[] } | undefined;
  return (j?.entries ?? []).map((e) => ({
    id: e.id ?? fingerprint("ledger", e.location, e.category),
    source: "ledger" as const,
    location: e.location,
    category: e.category,
    severity: e.severity ?? "medium",
    excerpt: redact(e.excerpt ?? "", 240),
    fix: e.fix ?? "",
    status: e.status ?? "open",
    reason: e.reason,
  }));
}

export const relPath = (p: string) =>
  relative(srcRoot(), p).replaceAll("\\", "/");
