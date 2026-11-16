#!/usr/bin/env -S bun --no-env-file
// claude-nhitl: launch Claude Code headless with no human in the loop.
//
// Usage: bun claude-nhitl.ts [options] [--] <prompt...>      (prompt "-" = read stdin)
//   --goal <text>        open goal: the Stop hook keeps the run going until the reply contains NHITL_DONE (loop-capped)
//   --resume <id>        resume a session (UUID or name); --continue resumes the latest in --cwd
//   --session-id <uuid>  fix the id of a new session (default: random UUID)
//   --cwd <dir>          working directory (default: current)
//   --model <m> --max-turns <n> --max-budget-usd <x> --add-dir <d> (repeatable) --append-system-prompt <t>
//   --log-dir <dir>      where to tee the stream (default ~/.claude/learning/runs)
//   --sandbox <wsl|native|off>  OS boundary (default: wsl on Windows, off elsewhere); --distro <name> for wsl
//   --quiet              print only the final result text instead of the raw stream
//
// Contract for runners: stdout = Claude Code stream-json lines (last one is {"type":"result",...});
// stderr first line = `nhitl-run {"sid":...,"log":...,"cwd":...}`; exit code = claude's exit code
// (1 also when the result reports is_error). The full stream is also written to <log-dir>/<sid>.jsonl.
// Run it with `bun --no-env-file`: entries bun loaded from a .env of the launch directory are
// never passed to claude (an ANTHROPIC_API_KEY there would override the claude.ai login).
// As root (Linux), Claude Code refuses bypassPermissions: claude runs as NHITL_RUN_AS (default
// agent, the runner user of tools/agents) through runuser; IS_SANDBOX is never forced. No such user: exit 2.
import { chownSync, mkdirSync } from "node:fs";
import { resolveSandbox, sandboxSettings, wslArgv } from "../src/sandbox.ts";
import { envWithoutDotenv, HOME, writeGoal } from "../src/lib.ts";

const argv = Bun.argv.slice(2);
const opt: Record<string, string | boolean> = {};
const addDirs: string[] = [];
const prompt: string[] = [];
const valued = new Set([
  "goal",
  "resume",
  "session-id",
  "cwd",
  "model",
  "max-turns",
  "max-budget-usd",
  "log-dir",
  "append-system-prompt",
  "add-dir",
  "sandbox",
  "distro",
]);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--") {
    prompt.push(...argv.slice(i + 1));
    break;
  }
  if (a.startsWith("--") && valued.has(a.slice(2))) {
    const v = argv[++i] ?? "";
    if (a === "--add-dir") addDirs.push(v);
    else opt[a.slice(2)] = v;
  } else if (
    a === "--continue" ||
    a === "--quiet" ||
    a === "-h" ||
    a === "--help"
  )
    opt[a.replace(/^-+/, "")] = true;
  else prompt.push(a);
}
if (opt.help || opt.h) {
  console.log(
    (await Bun.file(import.meta.path).text())
      .split("\n")
      .slice(1, 16)
      .map((l) => l.replace(/^\/\/ ?/, ""))
      .join("\n"),
  );
  process.exit(0);
}

let text = prompt.join(" ");
if (text === "-") text = await Bun.stdin.text();
const resume = typeof opt.resume === "string" ? opt.resume : "";
const uuidRx =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sid =
  resume && uuidRx.test(resume)
    ? resume
    : typeof opt["session-id"] === "string"
      ? opt["session-id"]
      : crypto.randomUUID();
if (!text && !opt.goal) {
  console.error("claude-nhitl: prompt or --goal required (see --help)");
  process.exit(2);
}
if (!text)
  text = `Objectif : ${opt.goal}. Travailler jusqu'au bout sans poser de question ; terminer par NHITL_DONE.`;
const cwd = typeof opt.cwd === "string" ? opt.cwd : process.cwd();

// Root: find the unprivileged user that will run claude.
let runAs: { name: string; uid: number; gid: number; home: string } | null =
  null;
if (process.platform !== "win32" && process.getuid?.() === 0) {
  const name = process.env.NHITL_RUN_AS || "agent";
  const pw = Bun.spawnSync(["getent", "passwd", name], {
    stdout: "pipe",
    stderr: "ignore",
  })
    .stdout.toString()
    .trim()
    .split(":");
  if (pw.length < 7 || pw[2] === "0") {
    console.error(
      `claude-nhitl: root, et l'utilisateur non-root « ${name} » est absent ; Claude Code refuse bypassPermissions en root. Créer l'utilisateur ou définir NHITL_RUN_AS.`,
    );
    process.exit(2);
  }
  runAs = { name, uid: Number(pw[2]), gid: Number(pw[3]), home: pw[5]! };
}
if (typeof opt.goal === "string" && opt.goal) {
  const p = writeGoal(sid, opt.goal, runAs?.home);
  if (runAs)
    for (const x of [
      p,
      `${runAs.home}/.claude/state/nhitl`,
      `${runAs.home}/.claude/state`,
      `${runAs.home}/.claude`,
    ])
      chownSync(x, runAs.uid, runAs.gid);
}
const logDir =
  typeof opt["log-dir"] === "string"
    ? opt["log-dir"]
    : `${HOME}/.claude/learning/runs`;
mkdirSync(logDir, { recursive: true });
const logPath = `${logDir}/${sid}.jsonl`;

const args = [
  ...(runAs ? ["runuser", "-u", runAs.name, "--"] : []),
  "claude",
  "-p",
  text,
  "--permission-mode",
  "bypassPermissions",
  "--permission-prompts",
  "none",
  "--output-format",
  "stream-json",
  "--verbose",
];
if (resume) args.push("--resume", resume);
else if (opt.continue) args.push("--continue");
else args.push("--session-id", sid);
for (const k of [
  "model",
  "max-turns",
  "max-budget-usd",
  "append-system-prompt",
])
  if (typeof opt[k] === "string") args.push(`--${k}`, opt[k] as string);
for (const d of addDirs) args.push("--add-dir", d);

let sandbox;
try {
  sandbox = resolveSandbox(opt.sandbox as string | undefined, process.platform);
} catch (e) {
  console.error(`claude-nhitl: ${(e as Error).message}`);
  process.exit(2);
}
if (sandbox !== "off") {
  const roots = [cwd, ...addDirs];
  args.push(
    "--settings",
    sandboxSettings({
      writeRoots: roots,
      protectedGit: roots.map((r) => `${r}/.git`),
    }),
  );
}
let spawnArgs = args;
if (sandbox === "wsl") {
  if (process.platform !== "win32" && !process.env.NHITL_WSL_FORCE) {
    console.error("claude-nhitl: --sandbox wsl needs Windows (wsl.exe)");
    process.exit(2);
  }
  spawnArgs = wslArgv({
    distro: opt.distro as string | undefined,
    cwd,
    env: { NHITL_RUN: "1" },
    claudeArgs: args,
  });
}

function childEnv(): Record<string, string> {
  const e = envWithoutDotenv(
    process.env,
    process.cwd(),
    !process.execArgv.includes("--no-env-file"),
  );
  e.NHITL_RUN = "1";
  if (runAs) {
    delete e.IS_SANDBOX;
    Object.assign(e, {
      HOME: runAs.home,
      USER: runAs.name,
      LOGNAME: runAs.name,
    });
  }
  return e;
}

console.error(
  `nhitl-run ${JSON.stringify({ sid, log: logPath, cwd, user: runAs?.name, sandbox })}`,
);
const child = Bun.spawn(spawnArgs, {
  cwd,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "inherit",
  env: childEnv(),
  windowsHide: true,
});
const sink = Bun.file(logPath).writer();
const dec = new TextDecoder();
let buf = "";
let result: any = null;
for await (const chunk of child.stdout) {
  sink.write(chunk);
  if (!opt.quiet) process.stdout.write(chunk);
  buf += dec.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.includes('"type":"result"')) {
      try {
        result = JSON.parse(line);
      } catch {}
    }
  }
}
await sink.end();
const code = await child.exited;
if (opt.quiet) process.stdout.write(`${result?.result ?? ""}\n`);
process.exit(code || (result?.is_error ? 1 : 0));
