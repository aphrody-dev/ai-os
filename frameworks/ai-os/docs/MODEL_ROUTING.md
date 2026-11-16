# Model routing

Fetched 2026-11-13. Prices in USD per million tokens (MTok), standard tier, global routing.

Sources:

- [A1] https://platform.claude.com/docs/en/about-claude/pricing
- [A2] claude-api skill model table (cached 2026-11-03; matches A1 on every listed price)
- [G1] https://aistudio.google.com/docs/pricing (redirect target of ai.google.dev/gemini-api/docs/pricing)
- [G2] https://aistudio.google.com/docs/models
- [G3] https://aistudio.google.com/docs/thinking
- [L1] relay `llm_models` (antigravity, claude providers), `claude --help`, `agy --help`

## Claude (Anthropic API), ranked by output price

| Model id                           | In    | Out   | Cache hit   | Batch in/out | Context | Thinking                                                        | Source |
| ---------------------------------- | ----- | ----- | ----------- | ------------ | ------- | --------------------------------------------------------------- | ------ |
| claude-haiku-5-5 (<=100k prompt)   | 0.10  | 0.50  | 0.01        | 0.05 / 0.25  | 1M      | adaptive, effort low..max, default medium                       | A1, A2 |
| claude-haiku-5-5 (>100k prompt)    | 0.50  | 2.50  | 0.05        | 0.25 / 1.25  | 1M      | same                                                            | A1     |
| claude-haiku-4-5                   | 1.00  | 5.00  | 0.10        | 0.50 / 2.50  | 200K    | budget_tokens                                                   | A1, A2 |
| claude-sonnet-5-5                  | 2.00  | 10.00 | 0.10        | 1.00 / 5.00  | 1M      | adaptive, effort low..max (default high); `between_tools` = off | A1, A2 |
| claude-sonnet-5                    | 2.00  | 10.00 | 0.20        | 1.00 / 5.00  | 1M      | adaptive, effort low..max                                       | A1     |
| claude-sonnet-4-6                  | 3.00  | 15.00 | 0.30        | 1.50 / 7.50  | 1M      | adaptive, effort low..max (no xhigh)                            | A1     |
| claude-opus-5-5                    | 4.00  | 20.00 | 0.20        | 2.00 / 10.00 | 1M      | always on, effort low..max, default medium                      | A1, A2 |
| claude-opus-5 / 4-8 / 4-7 / 4-6    | 5.00  | 25.00 | 0.50        | 2.50 / 12.50 | 1M      | adaptive                                                        | A1     |
| claude-fable-5-2 (Mythos 5.2 same) | 8.00  | 40.00 | 0.20        | 4.00 / 20.00 | 1M      | always on, effort low..max                                      | A1, A2 |
| claude-fable-5-1 / fable-5         | 10.00 | 50.00 | 0.25 / 1.00 | 5.00 / 25.00 | 1M      | always on                                                       | A1     |

Cache writes: 1.25x base (5 min TTL), 2x base (1 h). Batch = 50 % off in and out; stacks with caching. US-only `inference_geo` = 1.1x. Fast mode: Opus 5.5 8/40, Fable 5.2 16/80, not with batch. Thinking tokens bill as output. (A1)

## Gemini (Gemini API / AI Studio), ranked by output price

| Model id               | In                          | Out           | Cache       | Batch in/out               | Context    | thinking_level (default) | Source     |
| ---------------------- | --------------------------- | ------------- | ----------- | -------------------------- | ---------- | ------------------------ | ---------- |
| gemini-2.5-flash-lite  | 0.10                        | 0.40          | 0.01        | 0.05 / 0.20                | not stated | low/medium/high (off)    | G1, G2, G3 |
| gemini-3.1-flash-lite  | 0.25                        | 1.50          | 0.025       | 0.125 / 0.75               | not stated | minimal..high (minimal)  | G1, G3     |
| gemini-3.5-flash-lite  | 0.30                        | 2.50          | 0.03        | 0.15 / 1.25                | not stated | minimal..high (minimal)  | G1, G3     |
| gemini-3-flash-preview | 0.50                        | 3.00          | 0.05        | 0.25 / 1.50                | not stated | minimal..high (high)     | G1, G3     |
| gemini-3.8-flash       | 0.75 (1.50 from 2027-01-01) | 3.75 (7.50)   | 0.075       | 0.375 / 1.875              | not stated | low..high (medium)       | G1, G3     |
| gemini-3.6-flash       | 0.75 (1.50)                 | 3.75 (7.50)   | 0.075       | 0.375 / 1.875              | not stated | minimal..high (medium)   | G1, G3     |
| gemini-4-hydrogen      | 1.50                        | 7.50          | 0.075       | 0.75 / 3.75                | 1M         | low..xhigh (high)        | G1, G2, G3 |
| gemini-4-argon         | 2.00 (4.00 from 2026-12-01) | 10.00 (20.00) | 0.10 (0.20) | 1.00 / 5.00 (2.00 / 10.00) | 1M         | low..high (medium)       | G1, G2, G3 |
| gemini-4-carbon        | 2.00 (4.00 from 2026-12-01) | 10.00 (20.00) | 0.10 (0.20) | 1.00 / 5.00 (2.00 / 10.00) | 1M         | low..high (medium)       | G1, G2, G3 |
| gemini-3.1-pro-preview | 2.00 / 4.00 >200k           | 12.00 / 18.00 | 0.20 / 0.40 | 1.00 / 6.00                | not stated | low..high (high)         | G1, G3     |

Thinking tokens bill as output; `max_output_tokens` covers thinking + answer. G3 documents only `thinking_level` (no `thinkingBudget`); `minimal` is not available on Gemini 4 or 3.8 Flash. Free tier exists for Hydrogen and Flash/Flash-Lite, not Carbon/Argon. (G1, G3)

Web picker mapping (confirmed by G2): Flash-Lite 3.5 = `gemini-3.5-flash-lite`, Hydrogen 4 = `gemini-4-hydrogen`, Argon 4 = `gemini-4-argon`, Carbon 4 = `gemini-4-carbon` (strongest reasoning).

## Reachable locally (L1)

- antigravity (`agy`): gemini-4-{carbon,argon}-{low,medium,high}, gemini-4-hydrogen-{low,medium,high,xhigh}, gemini-3.8-flash-{low,medium,high}, claude-opus-5-5-{low,medium,high}, claude-sonnet-5-5-{low,medium,high}, gpt-oss-120b-medium. No Flash-Lite, no Haiku.
- claude CLI: `--model`, `--effort low|medium|high|xhigh|max`, `--fallback-model`; relay exposes only `claude/default`.
- Also present: ollama gemma4:e2b, fabric qwen3-0.6b, ~40 Cloudflare Workers AI models (not ranked here).

## Conflicts and caveats

- Gemini 4 Carbon/Argon prices double on 2026-12-01; Gemini 3.8/3.6 Flash double on 2027-01-01 (G1). Recheck routing then: after 2026-12-01 Carbon High costs as much as Opus 5.5 per output token.
- Haiku 5.5 (0.10/0.50) is cheaper than every Gemini Flash-Lite except 2.5 Flash-Lite, but its price jumps 5x above 100k prompt tokens (A1).
- G2 states no context window for Flash/Flash-Lite models; long-context routes use only models with a stated 1M window.
- Haiku 5.5 and Gemini Flash-Lite are not reachable via `agy`; they need direct API keys (`llm_ask` providers or SDK).
- Haiku 5.5 has no server-side refusal fallback (A2); fallback is handled by our router.
- `gemini-2.5-flash` / `-pro` are deprecated and reroute on 2026-12-01 (G2); not used.

## Per-task routing

Cost estimates use standard prices above (pre-2026-12-01), thinking counted as output.

| Task                                        | Typical call                        | Primary                                      | Est. cost                 | Fallback                         | Est. cost      |
| ------------------------------------------- | ----------------------------------- | -------------------------------------------- | ------------------------- | -------------------------------- | -------------- |
| pre-commit (small diff lint review)         | 5k in / 1k out                      | claude-haiku-5-5, effort low                 | $0.001                    | gemini-3.5-flash-lite, minimal   | $0.004         |
| CI PR review                                | 40k in / 4k out                     | gemini-4-hydrogen, medium                    | $0.09                     | claude-sonnet-5-5, effort medium | $0.12          |
| validation / judge /20                      | 30k in / 13k out                    | gemini-4-carbon, high (policy)               | $0.19 ($0.38 after 12-01) | claude-opus-5-5, effort high     | $0.38          |
| test generation                             | 20k in / 8k out                     | claude-sonnet-5-5, effort medium             | $0.12                     | gemini-4-hydrogen, medium        | $0.09          |
| flaky-test triage                           | 30k in / 2k out                     | claude-haiku-5-5, effort medium              | $0.004                    | gemini-3.5-flash-lite, low       | $0.014         |
| replic (re-run + minimise failure, agentic) | 50k in / 10k out per turn           | claude-sonnet-5-5, effort high               | $0.20                     | gemini-4-hydrogen, high          | $0.15          |
| orchestration / routing                     | 3k in / 0.3k out                    | claude-haiku-5-5, effort low                 | $0.0005                   | gemini-3.5-flash-lite, minimal   | $0.002         |
| long-context repo digest                    | 300k in / 8k out                    | claude-haiku-5-5 (>100k tier), effort medium | $0.17                     | gemini-4-hydrogen, low           | $0.51          |
| batch / offline                             | per 1M in / 0.1M out, cached prefix | claude-haiku-5-5 Batch API + cache reads     | $0.05 + $0.025            | gemini-3.5-flash-lite Batch      | $0.15 + $0.125 |

Escalation: any route whose primary fails twice or returns low confidence escalates one tier (Haiku 5.5 -> Sonnet 5.5 -> Opus 5.5; Flash-Lite -> Hydrogen -> Carbon). Use prompt caching on stable system prompts and repo context for every Claude route (cache hit 0.01-0.20, A1).
