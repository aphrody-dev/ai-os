import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Command-line agents serving as model providers (Antigravity `agy`, Claude Code `claude`):
// shared by the model bridge (models.ts) and the relay (relay/backends.ts). Shell-free execution, bounded timeout.

export type Answer = {
  text: string;
  engine: string;
  chat?: string;
  ms: number;
};

// An Anthropic API key in the environment takes precedence over the claude.ai login and disables its connectors (Gmail,
// Drive…); GOOGLE_GENAI_USE_VERTEXAI sends Gemini CLI to Vertex instead of the Google account. Removed for these engines.
const without = (...keys: string[]) =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !keys.includes(k)),
  ) as Record<string, string>;
export const CLAUDE_ENV = () =>
  without(
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_SERVICE_ACCOUNT_ID",
    "ANTHROPIC_WORKSPACE_ID",
  );

/** On Windows, a CLI installed as a .cmd shim (agy.cmd, codex.cmd) would pass its arguments through cmd.exe, which
 * interprets & | < > ^ %: Bun then refuses the call, and forcing it through cmd.exe would allow an injection through the
 * instruction. So the executable the shim calls is launched (line `"<exe>" %*`, `set "X=…"` variables and
 * environment variables resolved). If the shim does not resolve, the command is returned as is. */
export function resolveExe(name: string): string {
  if (process.platform !== "win32") return name;
  const p = Bun.which(name);
  if (!p || !/\.(cmd|bat)$/i.test(p)) return p ?? name;
  let text = "";
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return p;
  }
  const vars: Record<string, string> = {};
  const expand = (s: string) =>
    s.replace(
      /%(\w+)%/g,
      (_, k) =>
        vars[k] ?? process.env[k] ?? process.env[k.toUpperCase()] ?? `%${k}%`,
    );
  for (const m of text.matchAll(/^\s*set\s+"(\w+)=([^"]*)"/gim))
    vars[m[1]!] ??= expand(m[2]!);
  // First call `"<target>" %*`: the shim's default path, before its subcommand labels.
  const call = text.match(/^\s*"([^"]+)"\s+%\*/im)?.[1];
  const exe = call && expand(call);
  return exe && /\.exe$/i.test(exe) && !exe.includes("%") && existsSync(exe)
    ? exe
    : p;
}

export async function cli(
  engine: string,
  argv: string[],
  pick: (j: any) => string,
  env?: Record<string, string>,
): Promise<Answer> {
  const t0 = performance.now();
  argv = [resolveExe(argv[0]!), ...argv.slice(1)];
  const p = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: Number(Bun.env.AGENT_CLI_TIMEOUT_MS ?? 600_000),
    ...(env ? { env } : {}),
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0)
    throw new Error(`${engine} : code ${code} ${err.slice(0, 400)}`);
  let text = out.trim();
  try {
    text = pick(JSON.parse(out));
  } catch {}
  return { text, engine, ms: Math.round(performance.now() - t0) };
}

/** Long instruction for an agent that reads files (agy): written to a private temporary file, the command line
 * carries only the order to read it (Windows: 32,767 characters, ENAMETOOLONG; Linux: 128 KiB per argument).
 * Shared by agy() and the orchestrator's direct execution (orch/inline.ts). */
export function viaFile(prompt: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "agy-")), "prompt.md");
  writeFileSync(file, prompt, { mode: 0o600 });
  return `Read in full the file ${file} (${prompt.length} characters) and answer the request it contains, as if its content were this message.`;
}

/** Headless Antigravity CLI (`agy -p … --output-format json --mode plan`, 1.5.7): Antigravity session already open,
 * Gemini 4 models. Requested model (argument or RELAY_AGY_MODEL, e.g. gemini-4-carbon-high); if exhausted
 * (RESOURCE_EXHAUSTED, insufficient credits), retry with the account's default model. Measured: 1.96 s. */
export async function agy(
  prompt: string,
  model?: string,
  conversation?: string,
): Promise<Answer> {
  // Windows caps a command line at 32767 characters (ENAMETOOLONG): a long prompt goes to a private temp file
  // and agy (an agent with file access) is told to read it. Mode plan: it reads, it does not edit.
  const p = prompt.length > 8000 ? viaFile(prompt) : prompt;
  const argv = (m?: string) => [
    "agy",
    "-p",
    p,
    "--output-format",
    "json",
    "--mode",
    "plan",
    ...(m ? ["--model", m] : []),
    ...(conversation ? ["--conversation", conversation] : []),
  ];
  const pick = (j: any) => String(j.response ?? "").trim();
  const wanted = model ?? Bun.env.RELAY_AGY_MODEL;
  try {
    return await cli("antigravity", argv(wanted), pick);
  } catch (e: any) {
    if (!wanted || !/RESOURCE_EXHAUSTED|credits balance/i.test(e.message))
      throw e;
    const a = await cli("antigravity", argv(), pick);
    return { ...a, engine: `antigravity (fallback: ${wanted} exhausted)` };
  }
}

/** Headless Claude Code limited to the listed tools (e.g. claude.ai Google connectors), without any other permission. */
export const claudeWithTools = (prompt: string, tools: string[]) =>
  cli(
    "claude",
    [
      "claude",
      "-p",
      prompt,
      "--output-format",
      "json",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      tools.join(","),
      "--disallowedTools",
      "mcp__relay",
    ],
    (j) => String(j.result ?? ""),
    CLAUDE_ENV(),
  );

export const claude = (prompt: string, model?: string) =>
  cli(
    "claude",
    [
      "claude",
      "-p",
      prompt,
      "--output-format",
      "json",
      "--permission-mode",
      "plan",
      ...(model ? ["--model", model] : []),
    ],
    (j) => String(j.result ?? ""),
  );

export const opencode = (prompt: string, model?: string) =>
  cli(
    "opencode",
    [
      "opencode",
      "run",
      "--archived",
      "--format",
      "json",
      ...(model ? ["--model", model] : []),
      prompt,
    ],
    (j) => String(j.text ?? j.result ?? j.response ?? ""),
  );
