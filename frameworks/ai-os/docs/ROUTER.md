# Router (`src/router/`)

One catalog of model offers, one policy layer, one failover engine, served by the relay (`AphrodyRelay`, :8790).
Same auth as the relay (relay token or OAuth bearer; `x-api-key` is accepted on `/v1/*` for Anthropic clients).

## Sources (verified live 2026-11-15)

| Source              | URL                                                                                           | Gives                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery           | `llm/models.ts` (`llm_models`)                                                                | every provider model reachable now (ollama, fabric, `RELAY_OPENAI_ENDPOINTS`, openai, anthropic, google, openrouter, huggingface, vercel, cloudflare, agy, claude, opencode) |
| models.dev          | `https://models.dev/api.json`                                                                 | context, output limit, modalities, tool support, price                                                                                                                       |
| litellm             | `.../BerriAI/litellm/main/model_prices_and_context_window.json`                               | price map, limits, tool/vision flags                                                                                                                                         |
| OpenRouter          | `https://openrouter.ai/api/v1/models` (public)                                                | price, context, supported parameters                                                                                                                                         |
| Hugging Face router | `https://router.huggingface.co/v1/models` (public list)                                       | per-provider price, context, tools, first-token latency                                                                                                                      |
| Arena               | datasets-server `lmarena-ai/leaderboard-dataset`, config `text`, split `latest`, `first-rows` | overall rating and votes (top 100 rows; arena.ai itself answers 403 to scripts)                                                                                              |

Join key: normalised model name (last path segment, no `:variant`, no date, `[^a-z0-9]` to `-`); Arena matches the longest key an offer extends.
Distilled tables are cached in `relayHome()/router.db` (bun:sqlite, 6 h TTL, stale copy kept when a source fails); `router_models {refresh:true}` re-reads them.
Hugging Face chat: `POST https://router.huggingface.co/v1/chat/completions` (401 without `HF_TOKEN`; the provider is active only when `HF_TOKEN` is set). Local GGUF: `llama-server` was not found on `vps` (`command -v` exit 1); declare any OpenAI-compatible server with `RELAY_OPENAI_ENDPOINTS="name=url"`.

## Policy (`model`)

- `provider/model`: that offer, then the same model on other providers (cheapest first), then `auto`.
- bare name (`claude-sonnet-4-5`): offers of that model, cheapest healthy first, then `auto`. Unknown names route as `auto`.
- `auto` best Arena rating within budget; `auto:cheap` lowest price; `auto:fast` lowest measured p50; `auto:code` rating plus a boost for code-named models (no per-category Arena data is reachable); `auto:long` largest context.
- `arena`: two offers of different models answer, one answer returns (`router.pair_id`, header `x-router-pair`).
- Order: healthy API, unhealthy API (health < 0.5), healthy CLI agents (no tools, no real streaming), cooling offers. Tool/vision/context needs filter the list (relaxed rather than empty).
- Request extras: header `x-router-strict: 1` (no cross-model fallback), `x-router-fail: N` (simulate N failing offers), `x-caller: label`, body `router: {judge: true|"provider/model"}`.

## Failover

Walks the ordered list on 429, 5xx, timeout, auth, quota and empty or invalid answers (a reasoning model with no visible answer included). Cooldowns: 429 `Retry-After` (5 s to 5 min), auth 10 min, plan/quota messages 1 h, 5xx 15 s. Four non-transient 4xx in a row mean a bad request and end the walk with that status. After the full list: backoff 0.5 s, 1 s, and retry the five healthiest (3 rounds, 300 s deadline), then 503 with every attempt. Streaming fails over before the first byte only.
Stats (`calls` table): latency, errors, tokens, cost; health = `(ok+1)/(ok+err+1)` over weights decayed with a 10 min half-life.

## Arena and Elo

`router_vote {pair, winner: a|b|tie}`: `a` is the returned answer. Without `winner`, a judge model reads both answers (`llm_ask`) and votes. Elo K=32 from 1000, per model key, `router_leaderboard` (`local` Elo and `arena` public rating, never mixed).

## Endpoints

- `POST /v1/chat/completions` (OpenAI; SSE or JSON; tools and `tool_calls` pass through; `router.attempts` in the JSON, `x-router-offer`/`x-router-attempts` headers), `GET /v1/models` (offers plus `auto*`, `arena`, with context, price, tools, rating).
- `POST /v1/messages`, `/v1/messages/count_tokens` (Anthropic; text, image, tool_use, tool_result, SSE events). Point Claude Code with `ANTHROPIC_BASE_URL=http://127.0.0.1:8790` and `ANTHROPIC_AUTH_TOKEN=<relay token>`; Codex/OpenCode via an OpenAI base URL `http://127.0.0.1:8790/v1`.
- MCP/A2A/RPC tools: `router_models`, `router_route`, `router_leaderboard`, `router_vote`, `router_stats` (also sets a caller budget).
- Spend: per caller = sha256(bearer)[0..10] plus optional `x-caller`; cost = usage x offer price (tokens estimated at 4 chars when a provider omits usage); a caller over its budget gets HTTP 402.
- `gateway/index.ts` `/v1/chat/completions` is the agent gateway (runs the agent loop with sessions), not a model proxy: kept, separate from the relay router.

Tests: `bun test frameworks/ai-os/test/router` (fake providers), `just relay-e2e` (live, "router e2e").
