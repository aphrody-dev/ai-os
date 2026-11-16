# Reviews

Verdicts of the ai-os review tribunal (`frameworks/ai-os/src/review`): `<voice>-<date>-<slug>.md` per voice (gemini, claude, judge), one row per review in `INDEX.md`, checklists distilled from past verdicts in `CHECKLISTS.md`, screenshots proving a run in `proofs/`. The judge's score is final; the gate is `threshold` in `frameworks/ai-os/config/review.json`.

## Headless run (first route)

```sh
ai-os review <paths|diff|A..B|commit> [-- paths] --voice gemini --json
ai-os review --bundle <file> --voice gemini --json   # ===== FILE: path ===== bundle
ai-os review --files "src/**/*.ts" --web-mode carbon --web-thinking high --screenshot out.png
ai-os review --selftest gemini-web [--send]
```

- Exit code: 0 score at or above the threshold, 1 below it or frozen, 2 no engine answered; selftest 3 = login missing.
- Config and flags: the `$comment` of `review.json` lists every key; each has a flag (`--threshold`, `--temperature`, `--seed`, `--prompt`, `--include`, `--exclude`, `--lenient`, `--fresh`, `--web-*`, `--max-message-bytes`, `--headful`).
- Output: one fenced JSON block validated against `src/review/schema.ts` (`score`, `verdict`, `findings[{file, line, severity, title, breaks, fix, source}]`, `to_confirm`, `summary`), rendered to the verdict markdown. Invalid JSON gets one repair message in the same chat, then the engine fails; truncated or partial answers are never a passed gate. The cache key is the hash of the request (prompt, options, schema), in `var/review/cache.sqlite`.

## Gemini web engine

`src/review/gemini-web.ts`: gemini.google.com in the relay's dedicated headless Chrome over CDP (`relay/cdp.ts`, no claude-in-chrome). Each run opens a fresh chat, picks the mode (Carbon, then Argon) and thinking level from the `web` block, inserts the prompt with `Input.insertText` (split into several messages above `max_message_bytes`), waits for the Stop button to appear then disappear, reads the last `model-response message-content`, and records the chat URL and id in the verdict. Selectors live in one table (`SELECTORS`, references to `frameworks/ai-os/docs/gemini-web/RECON.md`); `--selftest gemini-web` checks each on the live page and names the broken one.

- No Google session: health `login` (10 minute cooldown, then `--fresh` ignores it). Normal case: the tool raises one Windows toast (auth daemon, `system/env-kit`); one click opens the relay Chrome headful on Google sign-in, the owner signs in, the window closes by itself as soon as the page shows the session, and the waiting review resumes (`web.login_wait_s`). Manual entry point: `ay auth login gemini-web` (or `ay auth login` to pick; `ay auth status` lists every service). Credentials are never typed by the tool.
- Other engines of the gemini voice follow: `agy`, then the `fallback` families; each failure is classified (`orch/classify.ts`) and skipped engines appear in the JSON (`voices[].skipped`, `voices[].attempts`).

## Manual fallback (last)

Only when the headless route has no engine: gemini.google.com through claude-in-chrome, route in `CLAUDE.md`. Archive the verdict in this folder like any other.

## Proofs

`proofs/gemini-web-login-wall-2026-11-15.png`: relay Chrome on gemini.google.com without a session, as captured by `--selftest gemini-web --screenshot` (reported as health `login`). `proofs/auth-toast-gemini-web-2026-11-15.png`: the sign-in toast on the PC (click or button opens the sign-in). A screenshot of an answer needs the owner's one-time sign-in.
