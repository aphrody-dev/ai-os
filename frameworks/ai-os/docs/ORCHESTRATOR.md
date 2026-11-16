# Multi-agent orchestrator (`ai-os orch`)

Code: `src/orch/`; tests: `test/orch/`; proof: `fixtures/orch/proof.json`.

The orchestrator runs a graph of steps computed at run time, in parallel, on the fleet hosts. For each step it picks an engine among those actually available (agent CLIs and discovered models). It fails over when an engine or a host fails, opens fix tickets, stops on its budgets and holds every external effect as long as the owner has not authorized it through a rule.

## Layers

| Layer                                                                             | Owner                                         | Role                                                                                                                                         |
| --------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `frameworks/ai-os/src/orch`                                                       | ai-os (this document)                         | graph, routing, failover, repair, lifecycle, guardrails                                                                                      |
| `tools/agents/runner.ts`, `tools/agents/fleet.toml`, `docs/agents/AGENT-FIRST.md` | labs-1b                                       | execution on the hosts: one tmux session per host (one window per role), queue `var/agents/queue`, commit bounded to paths, acceptance check |
| `src/llm`                                                                         | ai-os                                         | discovered providers and models (`llm_models`, `llm_ask`)                                                                                    |
| `src/relay`                                                                       | ai-os                                         | tools `orch_run`, `orch_engines`, `fleet_status`, `gemini_review` (MCP, A2A, JSON-RPC)                                                       |
| ssh, WireGuard, cloudflared                                                       | infra agent (`ay auth`, `docs/infra/AUTH.md`) | access to the hosts; the orchestrator creates no tunnel                                                                                      |

Hosts: `tools/agents/fleet.toml` (`[hosts.*]`, roles, runner checkout), cross-referenced with `device/deploy.toml` (`ssh_alias`, `role`). A node with role `build` (fr1, reserved for Chromium and LLVM) is excluded outright. Cap per host: `ORCH_MAX_AGENTS_<HOST>`, otherwise `ORCH_MAX_AGENTS`, otherwise 3 locally and 2 remotely.

## Commands

```sh
just orch hosts                       # hosts, runner state (heartbeat, CLI probe, cooldowns)
just orch engines --edit              # candidates and computed `providers` list, per host
just orch engines --model agy:<model>
just orch health                      # cooldowns and observed outcomes (host, provider)
just orch run fixtures/orch/proof.json
just orch plan "<goal>"               # a planner produces the graph, which is then run
just lifecycle --task "<task>" --paths frameworks/ai-os [--apply]
just orch design aphrody [--url https://aphrody.com]
just orch market aphrody "<brief>"
```

All commands write JSON to stdout. Events go out as JSONL on stderr (except with `--quiet`) and into `$AGENT_HOME/orch/runs/<run>.jsonl`. The exit code is 0 if all steps are `done` or `held`. The same functions are exposed by the relay: `orch_run` and `orch_engines`.

## Workflow format

````json
{
  "name": "…",
  "limits": { "maxSteps": 48, "budgetUsd": 20 },
  "steps": [
    {
      "id": "a",
      "do": "cmd",
      "hosts": ["prd"],
      "run": "nice -n 19 cargo test -j 4",
      "timeout_s": 3600
    },
    {
      "id": "b",
      "do": "agent",
      "role": "reviewer",
      "deps": ["a"],
      "needs": { "context": 100000 },
      "prompt": "Review:\n{{a}}",
      "out": "docs/reviews/claude-2026-11-13-x.md"
    },
    {
      "id": "c",
      "do": "agent",
      "role": "coder",
      "deps": ["b"],
      "needs": { "edit": true },
      "prompt": "Fix:\n{{b}}",
      "check": "bun check",
      "commit": { "paths": ["frameworks/ai-os"], "message": "…" }
    },
    { "id": "d", "do": "tool", "tool": "fleet_status", "args": {} },
    {
      "id": "e",
      "do": "agent",
      "role": "sre",
      "expand": true,
      "prompt": "… answer with ```json {\"steps\":[…]} ```"
    }
  ]
}
````

| Field                | Effect                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `do`                 | `cmd`: sh line run in the host checkout, or in `$HOME` with `"repo": false`; `agent`: sub-agent; `tool`: relay tool                                                                                           |
| `deps`, `{{id}}`     | graph order; `{{id}}` receives the output of step `id` (20,000 characters at most)                                                                                                                            |
| `hosts`              | allowed hosts, in order of preference; by default, those whose `fleet.toml` lists the role, local host first                                                                                                  |
| `needs`              | declared needs for routing (next section)                                                                                                                                                                     |
| `check`, `commit`    | passed to the runner: acceptance check, then commit limited to the `paths` prefixes                                                                                                                           |
| `expand`             | the output may add steps (`{"steps":[…]}`). Their identifiers are prefixed by the parent's. They inherit its restrictions (external effect, commit paths). Additions are bounded by `maxSteps` and `maxDepth` |
| `out`                | the output is written to a file, under `docs/reviews/` or `var/` only                                                                                                                                         |
| `effect: "external"` | publication, sending or spending: the step is held (see "External effects checkpoint")                                                                                                                        |
| `onFail`             | `fix` (default for `cmd`) opens a fix ticket; `continue` lets the dependents through; `stop` skips them                                                                                                       |

Execution of an `agent` step:

- if a worker of the role is beating on the host (`state/heartbeat-<role>` less than 2 minutes old), the task goes into the runner queue, in the v1 format of `docs/agents/AGENT-FIRST.md`: `queue/tmp`, then rename into `queue/new`. The orchestrator then reads `results/<id>/result.json` and the log of the accepted attempt;
- otherwise, a read-only step (review, judgment, plan, draft) is launched directly: CLI in plan mode or in a read-only sandbox, remotely over ssh with `nice -n 19` and `timeout`, locally at BELOW_NORMAL priority;
- a step that modifies files always goes through the queue: only the runner knows how to bound commits and judge with `check`.

## Declarative routing (`select.ts`)

A step describes its needs in `needs`. No model list is written in the code.

- `edit`: the step modifies files. Only agent CLIs qualify, because `llm_ask` only answers with text.
- `tools`, `reasoning`, `context`: filters applied to the models.dev metadata (`tool_call`, `reasoning`, `limit.context`).
- `prefer`: `reliability` (default), `cost` or `latency`, like OpenRouter's `provider.sort`.
- `only`, `ignore`: regular expressions on the identifier, like OpenRouter's `provider.only` and `provider.ignore`.
- `models`: desired models, tried first (OpenRouter's `models` parameter, the AI Gateway's `gateway.models` option). `cli:model` is followed by `cli`, its default model.

Building the candidate list:

- the CLIs the runner knows how to launch (`claude`, `codex`, `opencode`, `pi`, `agy`), present on the host: runner probe `state/health.json`, otherwise `command -v`;
- on the local host, the models from `llm_models`, enriched by `https://models.dev/api.json` (24 h cache in `$AGENT_HOME`).

Sorting relies on the health learned per host and per provider (`$AGENT_HOME/orch.sqlite`): smoothed success rate, p50 latency, cost. Excluded:

- providers in local cooldown;
- the runner's `state/cooldown-*` files;
- keys already tried for the step.

The result is the `providers` list of the v1 task, which the runner tries in order.

## Failover and repair

| Class (`classify.ts`) | Signal                                            | Action                                                                 |
| --------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `quota`               | 402, credits, account quota, `RESOURCE_EXHAUSTED` | 15 min cooldown doubled on each failure, next provider without waiting |
| `throttle`            | 429 / rate limit without quota text               | one retry after `Retry-After` (60 s at most), then next provider       |
| `auth`                | expired session, 401/403                          | set aside 6 h on this host, next provider                              |
| `missing`             | binary or checkout absent (127)                   | next host; no fix ticket                                               |
| `context`, `policy`   | context exceeded, content refusal                 | next provider                                                          |
| `timeout`, `overload` | timeout, 5xx, network                             | one retry, then next provider                                          |
| `task`                | the engine answered, the task failed              | `cmd`: fix ticket; `agent`: next provider                              |

When no provider on a host answers, the step moves to the next host in `hosts`. An already queued task is withdrawn (`queue/failed`) if all its attempts are `provider_unavailable`.

Fix ticket: a failed `cmd` step spawns `<id>#fix<n>`, an `agent` step. It takes the `coder` role with `needs.edit` and receives the tail of the output. Its `check` is the command itself. Dependents wait for the ticket. There are at most `fixRounds` tickets per step (`ORCH_FIX_ROUNDS`, 1 by default). The runner adds its own self-correction round per provider.

## Guardrails

| Limit                                                                                                         | Default               | Variable                   |
| ------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------- |
| steps, generated ones included                                                                                | 48                    | `ORCH_MAX_STEPS`           |
| expansion depth                                                                                               | 3                     | `ORCH_MAX_DEPTH`           |
| budget in $ (sum of the `budget_usd` handed to the queue; the runner applies them through `--max-budget-usd`) | 20                    | `ORCH_BUDGET_USD`          |
| tokens of direct executions                                                                                   | 2,000,000             | `ORCH_TOKEN_BUDGET`        |
| deadline                                                                                                      | 4 h                   | `ORCH_DEADLINE_MS`         |
| consecutive failures before stopping                                                                          | 4                     | `ORCH_MAX_FAILS`           |
| simultaneous agents per host                                                                                  | 3 locally, 2 remotely | `ORCH_MAX_AGENTS[_<HOST>]` |

Other guardrails:

- cycle detection;
- no endless loop: every step has a timeout, every retry a bounded number of attempts;
- low priority everywhere;
- compilation and containers on prd only (`nice -n 19`, `-j 4`).

## External effects checkpoint

External effects are refused by default: publication, sending a message, spending.

- **Step marked `effect: "external"`** (or inherited from a parent that is): it is run only if a rule in `.agents/owner-rules.json` allows it. Expressions are anchored (full match): `step` targets the exact step identifier (a generated step `publish.x` does not benefit from a `publish` rule), optional `command` its command line. A rule without `step` only applies to the agent guard. This file is written only by the owner:
  ```json
  {
    "rules": [
      {
        "effect": "external",
        "step": "publish-aphrody-blog",
        "command": "bun run --cwd apps/web publish-blog",
        "granted": "YYYY-MM-DD",
        "note": "…"
      }
    ]
  }
  ```
- **Without a rule**, the step takes the `held` state: its content (draft, filled-in instruction) is queued in `var/agents/outbox/<run>/<step>.json`. The marketing drafts of `just orch market` are written to `var/agents/outbox/<product>-<date>.md`, and nothing is published.
- **Queue tasks**: an authorized external step goes out with `approval: "none"`; the other `growth` tasks go out with `approval: "owner"`, which the runner never commits. An external step never runs directly (read-only): without a worker, it fails instead of appearing done.
- **Commands launched by the agents themselves**: no PreToolUse guard checks publication; only the orchestrator steps above go through the owner rules.

## Lifecycle (`lifecycle.ts`)

`just lifecycle` chains, without a human:

1. code (`coder` sub-agent, if `--task`);
2. `bun fmt --check` of the paths (a drift opens a coder ticket that formats and commits); single git sync of prd;
3. in parallel: `bun check` and `cargo clippy` on prd;
4. tests: `bun test` (packages), `cargo test` and `go test` on prd;
5. judges in parallel:
   - Gemini web via `gemini_review` (relay Chrome);
   - a Claude judge (role `reviewer`, context ≥ 100,000);
   - verdicts written to `docs/reviews/<judge>-<date>-<subject>.md`;
6. fix of the verified defects (`check`: `bun check`);
7. `docker build --target runtime` on prd (Alpine, root `Dockerfile`);
8. `ay deploy up --all --dry-run` (`--apply` to deploy);
9. `fleet_status`;
10. optimization: an `sre` agent proposes at most 3 tasks, added to the graph (`expand`).

Product variants:

- `design`: PRD and DESIGN.md (`gds plan`), then `gds verify`, `wck`, and a judge;
- `market`: facts from `git log`, drafts written, publication `held`.

## Execution proof (2026-11-13, `fixtures/orch/proof.json`)

Run `20261113T013445-proof-fleet-vycu` (26.8 s, ok), after the runners were put into service on pc, prd and fr2: the `agent` steps go through the v1 queues.

| Step             | Host     | Attempts                                                                                          |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------- |
| pc-gemini        | pc       | queue: `agy:gemini-4-carbon-high` excluded (quota cooldown learned in the previous run), `agy` ok |
| pc-claude        | pc       | queue: `claude` ok                                                                                |
| prd-agent        | prd      | queue: `claude` excluded on prd (auth cooldown learned), routed to `opencode`, ok                 |
| prd-sys, fr2-sys | prd, fr2 | commands in parallel, `nice=19`                                                                   |
| plan             | pc       | queue: `claude` ok; plan.disk-prd and plan.disk-fr2 generated at run time, ok                     |
| publish          | —        | `held`                                                                                            |

Run `20261113T010749-proof-fleet-p9kk` (14.9 s, direct execution, before the runners):

| Step      | Host        | Attempts                                                                                           |
| --------- | ----------- | -------------------------------------------------------------------------------------------------- |
| pc-gemini | pc          | `agy:gemini-4-carbon-high` quota (exhausted), then `agy` ok                                        |
| pc-claude | pc          | `claude` ok                                                                                        |
| prd-agent | prd then pc | `prd/claude` auth (OAuth session expired on prd), then `pc/claude` ok                              |
| prd-sys   | prd         | ok: `nproc=8 nice=19`, tmux 3.8, bun 1.4.4                                                         |
| fr2-sys   | fr2         | ok: `nproc=6 nice=19`, tmux 3.7b, bun 1.4.4                                                        |
| plan      | pc          | `claude` ok; two steps generated at run time: plan.disk-prd (prd) and plan.disk-fr2 (fr2), both ok |
| publish   | —           | `held`: external effect without a rule, queued in `var/agents/outbox/`                             |

Gemini review (Carbon High, gemini.google.com): 9.5/20, verdict and follow-ups in `docs/reviews/gemini-2026-11-13-orch.md`.

## Comparison with reference projects (survey of 2026-11-13)

| Project                                    | What is taken                                                                                                                                                                                                                                                                                                                                                  | Source                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| opencode @c5a1532                          | model registry with cost, context, `tool_call`, `reasoning` (models.dev); error classes separating quota (402, or 429 with a quota text) and throttle (429); sub-agents declared as data, without recursive delegation                                                                                                                                         | `third_party/opencode`: `system/core-ts/src/models-dev/v1.ts:9-60`, `packages/ai/src/provider-error.ts:230-266`, `packages/ai/src/schema/errors.ts:69-215`, `system/core-ts/src/plugin/agent.ts:55-95`                                                                                                                                       |
| opencode (counter-example)                 | its "small model" chosen from a hard-coded list of families: not taken                                                                                                                                                                                                                                                                                         | `system/core-ts/src/model.ts:307-319`                                                                                                                                                                                                                                                                                                        |
| OpenRouter                                 | `models` as a fallback list; `provider.only` / `ignore` / `sort`; 402 = credits (no retry), 429 and 503 with `Retry-After`                                                                                                                                                                                                                                     | https://openrouter.ai/docs/guides/routing/model-fallbacks, https://openrouter.ai/docs/guides/routing/provider-selection, https://openrouter.ai/docs/api/reference/errors-and-debugging                                                                                                                                                       |
| Vercel AI SDK @2ebc78b, AI Gateway         | provider registry addressed by `provider:model`; `isRetryable` for 408, 409, 429 and ≥ 500; `Retry-After` bounded at 60 s; `gateway.models` / `order`; attempts traced per model                                                                                                                                                                               | `third_party/vercel-ai`: `packages/ai/src/registry/provider-registry.ts:176-199`, `packages/provider/src/errors/api-call-error.ts:28-32`, `packages/ai/src/util/retry-with-exponential-backoff.ts:27-66`, `packages/gateway/src/gateway-provider-options.ts:58-145`; https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks |
| Google ADK js @13912a9, python @df9f9d0    | router called back after each failure with the keys already tried; fallback only before any output; sequential, parallel and bounded loop (`maxIterations`); agent used as a tool                                                                                                                                                                              | `third_party/adk-js`: `core/src/utils/failover_utils.ts:22-75`, `core/src/agents/loop_agent.ts:22,88`; `third_party/adk-python`: `src/google/adk/models/_fallback_model.py:207-280`                                                                                                                                                          |
| A2A                                        | agent card with skills and capabilities (served by the relay)                                                                                                                                                                                                                                                                                                  | `third_party/adk-js/core/src/a2a/agent_card.ts:379-459`                                                                                                                                                                                                                                                                                      |
| OpenAI Agents SDK js @7589b9c              | bounded `maxTurns` with a typed error; input and output guardrails; agents used as tools (`asTool`)                                                                                                                                                                                                                                                            | `third_party/openai-agents-js`: `packages/agents-core/src/runner/constants.ts:2`, `packages/agents-core/src/agent.ts:355-447,765`                                                                                                                                                                                                            |
| Claude Agent SDK 0.3.323 (npm, 2026-11-12) | `fallbackModel`, `maxTurns`, `maxBudgetUsd`, PreToolUse hooks, `permissionMode`. The SDK launches the Claude Code binary (`spawn`, `--output-format stream-json`) and embeds Claude Code 2.1.323 as per-platform optional dependencies. ai-os therefore drives the `claude` CLI directly (2.1.322 on the PC): no npm dependency, in line with the package rule | `npm view @anthropic-ai/claude-agent-sdk` (version 0.3.323, `claudeCodeVersion` 2.1.323, peer `zod`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`); types read from the 0.3.312 package (`sdk.d.ts`)                                                                                                                                     |
| Cursor                                     | parallel, isolated cloud agents; explicit model or default user → team → system; "Auto" mode criteria not published                                                                                                                                                                                                                                            | https://cursor.com/docs/cloud-agent, https://cursor.com/docs/cloud-agent/api/endpoints, https://cursor.com/docs/models                                                                                                                                                                                                                       |
| LiteLLM Router @a7052ea8                   | per-deployment cooldown after failures (429, 401, 402, 404, 408, 5xx); distinct fallbacks for context overflow and content refusal; routing by cost and by latency                                                                                                                                                                                             | `third_party/litellm`: `litellm/router_utils/cooldown_handlers.py:285-331`, `litellm/router_utils/fallback_event_handlers.py:265-275`, `litellm/router.py:80-115`                                                                                                                                                                            |
