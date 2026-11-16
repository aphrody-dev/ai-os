// Direct execution of a read-only step (review, judgment, plan, draft) when no runner listens
// on the host: same addressing as the queue ("cli[:model]" or "provider/model"), CLIs in plan / read-only
// sandbox mode, with no internal fallback added (switching belongs to the orchestrator). Steps that modify
// files always go through the runner queue (commit bounded to paths, acceptance check).
import { resolveExe, viaFile } from "../llm/agents";
import { llmAsk } from "../llm/model";
import { classify, type FailClass } from "./classify";
import { exec, type Host } from "./fleet";

export type InlineResult = {
  ok: boolean;
  text: string;
  cls?: FailClass;
  ms: number;
  tokens: number;
  /** Web engines: chat URL and id of the run, mode used, non-fatal findings (recorded in the verdict). */
  chat?: string;
  chatId?: string;
  mode?: string;
  notes?: string[];
};

const ARGV_MAX = 24_000; // Windows command line: 32,767 characters

function argvFor(
  cli: string,
  model: string | undefined,
  prompt: string,
  winLocal: boolean,
  local = winLocal,
): { argv: string[]; stdin?: string } | string {
  const m = (flag: string) => (model ? [flag, model] : []);
  // agy reads files: locally, a long instruction goes through a private file (llm/agents.ts viaFile).
  const file = cli === "agy" && local && prompt.length > 8000;
  // Windows command line is bounded: an instruction too long is never silently truncated, the engine is discarded.
  if (cli !== "claude" && !file && winLocal && prompt.length > ARGV_MAX)
    return `instruction of ${prompt.length} characters: too long for the Windows command line of ${cli}`;
  const p = file ? viaFile(prompt) : prompt;
  switch (cli) {
    case "claude":
      return {
        argv: [
          "claude",
          "-p",
          "--output-format",
          "json",
          "--permission-mode",
          "plan",
          ...m("--model"),
        ],
        stdin: prompt,
      };
    case "agy":
      return {
        argv: [
          "agy",
          "-p",
          p,
          "--output-format",
          "json",
          "--mode",
          "plan",
          ...m("--model"),
        ],
      };
    case "codex":
      return {
        argv: [
          "codex",
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          ...m("-m"),
          p,
        ],
      };
    case "opencode":
      return { argv: ["opencode", "run", "--agent", "plan", ...m("-m"), p] };
    case "fx":
      return { argv: ["fx", "ask", p] };
    default:
      // pi has no read-only mode: it only goes through the runner queue.
      return `${cli}: no read-only mode for direct execution`;
  }
}

/** JSON response of the CLIs (claude: result/is_error/usage; agy: response) or plain text. */
function parse(out: string): {
  text: string;
  error?: boolean;
  errText?: string;
  tokens?: number;
} {
  try {
    const j = JSON.parse(out);
    const u = j.usage ?? {};
    const tokens =
      (u.input_tokens ?? 0) +
      (u.output_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0);
    const error = j.is_error === true || !!j.error;
    const errText = error
      ? [
          j.result,
          typeof j.error === "string" ? j.error : JSON.stringify(j.error ?? ""),
        ]
          .filter((x) => x && x !== '""')
          .join(" ")
      : undefined;
    return {
      text: String(j.result ?? j.response ?? j.text ?? out).trim(),
      error,
      errText,
      tokens: tokens || undefined,
    };
  } catch {
    return { text: out.trim() };
  }
}

const estimate = (...s: string[]) =>
  Math.ceil(s.reduce((n, x) => n + x.length, 0) / 4);

/** Sampling and output controls honoured by bridge models (agent CLIs expose none of them). */
export type InlineOpts = {
  temperature?: number;
  seed?: number;
  /** JSON schema of the answer (wire form). */
  schema?: Record<string, unknown>;
  schemaName?: string;
  thinking?: string;
  /** gemini-web engine settings (mode, thinking, budgets, timeouts; review/gemini-web.ts WebOpts). */
  web?: import("../review/gemini-web").WebOpts;
};

export async function inline(
  h: Host,
  provider: string,
  prompt: string,
  timeoutMs = 600_000,
  opts: InlineOpts = {},
): Promise<InlineResult> {
  const t0 = performance.now();
  const [cli, model] = provider.split(/:(.*)/s);
  if (cli === "gemini-web") {
    if (!h.local)
      return {
        ok: false,
        text: "gemini-web: local host only (relay Chrome)",
        cls: "missing",
        ms: 0,
        tokens: 0,
      };
    const { geminiWebAsk } = await import("../review/gemini-web");
    const r = await geminiWebAsk(prompt, {
      ...opts.web,
      // The voice's remaining budget bounds the configured wait.
      timeoutMs: Math.min(opts.web?.timeoutMs ?? timeoutMs, timeoutMs),
      schema: opts.schema,
      mode: model || opts.web?.mode,
    });
    return {
      ok: r.ok,
      text: r.text,
      cls: r.cls,
      ms: r.ms,
      tokens: estimate(prompt, r.text),
      chat: r.chat,
      chatId: r.chatId,
      mode: r.mode,
      notes: r.notes,
    };
  }
  if (provider.includes("/") && !provider.includes(":")) {
    if (!h.local)
      return {
        ok: false,
        text: "bridge model: local host only",
        cls: "missing",
        ms: 0,
        tokens: 0,
      };
    try {
      const r = await Promise.race([
        llmAsk(provider, prompt, undefined, {
          temperature: opts.temperature,
          seed: opts.seed,
          reasoningEffort: opts.thinking,
          responseSchema: opts.schema
            ? { name: opts.schemaName ?? "review", schema: opts.schema }
            : undefined,
        }),
        Bun.sleep(timeoutMs).then(() => {
          throw new Error(`timed out (${timeoutMs} ms)`);
        }),
      ]);
      const u = (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0);
      return {
        ok: !!r.text,
        text: r.text || "empty response",
        cls: r.text ? undefined : "task",
        ms: r.ms,
        tokens: u || estimate(prompt, r.text),
      };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      return {
        ok: false,
        text: msg,
        cls: classify(msg),
        ms: Math.round(performance.now() - t0),
        tokens: 0,
      };
    }
  }
  const spec = argvFor(
    cli!,
    model || undefined,
    prompt,
    h.local && process.platform === "win32",
    h.local,
  );
  if (typeof spec === "string")
    return { ok: false, text: spec, cls: "missing", ms: 0, tokens: 0 };
  const { argv, stdin } = spec;
  if (h.local) {
    // Never through cmd.exe (injection via the instruction): the executable targeted by the .cmd shim, otherwise the engine is discarded.
    argv[0] = resolveExe(argv[0]!);
    if (/\.(cmd|bat)$/i.test(argv[0]!))
      return {
        ok: false,
        text: `${cli}: shim ${argv[0]} not resolved to .exe; instruction not passed through cmd.exe`,
        cls: "missing",
        ms: 0,
        tokens: 0,
      };
  }
  // Remotely, a read-only step gets its context in the instruction: it runs from the home
  // directory, without requiring the runner checkout.
  const r = await exec(h, argv, { stdin, timeoutMs, home: !h.local });
  const j = parse(r.out);
  const ok = r.code === 0 && !j.error && !!j.text;
  const ms = Math.round(performance.now() - t0);
  if (ok)
    return {
      ok,
      text: j.text,
      ms,
      tokens: j.tokens ?? estimate(prompt, j.text),
    };
  // Classify on stderr and the structured error field, not on the text produced by the agent (which may quote
  // "401" or "billing" in a review).
  const diag = (
    j.error ? `${j.errText ?? j.text}\n${r.err}` : r.err || r.out.slice(-1000)
  )
    .trim()
    .slice(-4000);
  return {
    ok: false,
    text: diag || `code ${r.code}`,
    cls: r.code === 124 ? "timeout" : classify(diag, r.code),
    ms,
    tokens: j.tokens ?? 0,
  };
}
