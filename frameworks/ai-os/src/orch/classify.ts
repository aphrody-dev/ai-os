// Failure classes of an engine, from its output (code, stderr, error JSON). They decide the repair, with the
// same split as opencode's error classes (packages/ai/src/schema/errors.ts) and the LiteLLM router:
//   quota    : 402, credits, account quota, RESOURCE_EXHAUSTED   -> long cooldown, switch without waiting
//   throttle : 429 / rate limit without quota text                -> one bounded wait (Retry-After), then switch
//   auth     : expired session, 401/403                           -> engine discarded until the next probe
//   missing  : binary or checkout missing (ENOENT, code 127)      -> engine or host discarded
//   context  : context exceeded                                   -> engine with a larger context
//   policy   : refus de politique de contenu                        -> autre fournisseur
//   timeout  : timed out                                          -> one retry, then switch
//   overload : 5xx, overload, network                             -> retry after a wait, then switch
//   login    : Google web session missing in the relay's Chrome   -> toast, one click (auth login gemini-web)
//   task     : the engine answered but the task failed            -> fix ticket
export type FailClass =
  | "quota"
  | "throttle"
  | "auth"
  | "missing"
  | "context"
  | "policy"
  | "timeout"
  | "overload"
  | "login"
  | "task";

const RULES: [FailClass, RegExp][] = [
  [
    "quota",
    /insufficient_quota|quota\b.{0,40}\b(exceeded|exhausted|reached)|exceeded your (current )?quota|(daily|monthly) (quota|limit)|credits? balance|out of credits|insufficient credits|(status|http|error|code)\D{0,12}\b402\b|payment required|usage limit|hit your limit|billing|resource_exhausted.{0,200}(credit|billing|daily|plan)/is,
  ],
  [
    "throttle",
    /(status|http|error|code)\D{0,12}\b429\b|rate[ _-]?limit|too many requests|resource_exhausted/i,
  ],
  // API switched off on the project (Vertex, Gemini API): fixed by an owner action, engine discarded for a day.
  [
    "missing",
    /service_disabled|api_key_service_blocked|api has not been used in project|accessnotconfigured|api (is )?(not enabled|disabled)|has not been (enabled|used)/i,
  ],
  ["login", /google session missing|sign in required \(ay auth login/i],
  [
    "auth",
    /failed to authenticate|oauth session expired|not logged in|please (log|sign) ?in|login required|unauthori[sz]ed|(status|http|error|code)\D{0,12}\b40[13]\b|invalid api key|authentication (failed|required|error)/i,
  ],
  [
    "missing",
    /ENOENT|command not found|not recognized as an internal|executable file not found|checkout (absent|missing)/i,
  ],
  [
    "context",
    /context (length|window)|maximum context|prompt is too long|too many tokens|context_length_exceeded/i,
  ],
  [
    "policy",
    /content policy|content_policy|moderation|flagged by|safety filter/i,
  ],
  ["timeout", /timed? ?out|ETIMEDOUT|deadline exceeded|SIGTERM/i],
  [
    "overload",
    /(status|http|error|code)\D{0,12}\b(50[0234]|529)\b|overloaded|service unavailable|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|connection (reset|closed)/i,
  ],
];

export function classify(text: string, code?: number | null): FailClass {
  if (code === 127) return "missing";
  if (code === 124) return "timeout";
  for (const [c, re] of RULES) if (re.test(text)) return c;
  return "task";
}

/** Retry-After quoted in the output (seconds, "500ms", HTTP date or ISO), capped at 60 s; 0 if absent. */
export function retryAfterMs(text: string, now = Date.now()): number {
  const m = text.match(
    /retry[- _]after(?:-ms)?["']?\s*[:=]?\s*["']?([^\r\n"';]+)/i,
  );
  if (!m) return 0;
  const v = m[1]!.trim();
  const n = v.match(/^(\d+(?:\.\d+)?)\s*(ms|s)?\b/i);
  const ms = n
    ? Number(n[1]) *
      (n[2]?.toLowerCase() === "ms" || /retry[- _]after-ms/i.test(m[0])
        ? 1
        : 1000)
    : Date.parse(v) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), 60_000) : 0;
}

/** Cooldown of an engine after a failure of this class; 0 = none (failure specific to the task). */
export function cooldownMs(c: FailClass, fails: number): number {
  const exp = (base: number) => base * 2 ** Math.max(0, Math.min(fails - 1, 5));
  switch (c) {
    case "quota":
      return exp(15 * 60_000);
    case "throttle":
      return exp(60_000);
    case "auth":
      return 6 * 3600_000;
    case "login":
      return 10 * 60_000;
    case "missing":
      return 24 * 3600_000;
    case "overload":
      return exp(60_000);
    case "timeout":
      return exp(2 * 60_000);
    default:
      return 0;
  }
}

/** Failures that switch engine without retrying the same one. */
export const switches = (c: FailClass) =>
  c === "quota" ||
  c === "auth" ||
  c === "login" ||
  c === "missing" ||
  c === "context" ||
  c === "policy";
