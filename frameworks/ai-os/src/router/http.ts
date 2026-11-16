// HTTP surfaces of the router, mounted on the relay (relay/server.ts, same auth as the relay):
//   POST /v1/chat/completions  OpenAI, streaming SSE or JSON, tool calls passed through
//   GET  /v1/models            every routable offer plus the virtual models (auto, auto:cheap, ..., arena)
//   POST /v1/messages          Anthropic Messages (+ /v1/messages/count_tokens)
// Headers: x-router-fail: N (simulate N failing offers), x-router-strict: 1 (no cross-model fallback),
// x-caller: label (spend is tracked per bearer token and label).
import { type Body, Exhausted, type Router } from "./engine.ts";
import { VIRTUAL } from "./policy.ts";
import {
  anthropicStream,
  anthropicToOpenAI,
  openAIToAnthropic,
} from "./wire.ts";

/** Spend key: short hash of the bearer token (never the token) plus an optional label. */
export function callerOf(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  const t = a.startsWith("Bearer ")
    ? a.slice(7).trim()
    : (req.headers.get("x-api-key") ?? "");
  const h = new Bun.CryptoHasher("sha256").update(t).digest("hex").slice(0, 10);
  const label = (req.headers.get("x-caller") ?? "")
    .replace(/[^\w.-]/g, "")
    .slice(0, 32);
  return label ? `${h}/${label}` : h;
}

const sseHeaders = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
};
const info = (r: {
  offer: { id: string };
  attempts: unknown[];
  pair?: string;
}) => ({
  "x-router-offer": r.offer.id,
  "x-router-attempts": String(r.attempts.length),
  ...(r.pair ? { "x-router-pair": r.pair } : {}),
});

function errorResponse(e: any, anthropic: boolean) {
  const status = e instanceof Exhausted ? e.status : (e?.status ?? 500);
  const msg = String(e?.message ?? e);
  const type =
    status === 402
      ? "budget_exceeded"
      : status === 429
        ? "rate_limit_error"
        : status >= 500
          ? "api_error"
          : "invalid_request_error";
  return Response.json(
    anthropic
      ? { type: "error", error: { type, message: msg } }
      : { error: { message: msg, type, code: status } },
    { status },
  );
}

async function run(
  req: Request,
  router: Router,
  body: Body,
  anthropic: boolean,
) {
  const rb = (body as any).router ?? {};
  delete (body as any).router;
  const failFirst =
    Number(req.headers.get("x-router-fail") ?? rb.fail ?? 0) || 0;
  const strict =
    req.headers.get("x-router-strict") === "1" || rb.strict === true;
  const r = await router.complete(body, {
    caller: callerOf(req),
    stream: body.stream === true,
    signal: req.signal,
    failFirst,
    need: strict ? { strict: true } : undefined,
  });
  if (r.pair && rb.judge)
    router
      .judge(r.pair, typeof rb.judge === "string" ? rb.judge : undefined)
      .catch(() => {});
  return r;
}

export async function chatCompletions(
  req: Request,
  router: Router,
): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
    if (!Array.isArray(body.messages)) throw new Error("messages requis");
  } catch (e: any) {
    return errorResponse(
      { status: 400, message: `corps invalide : ${e.message}` },
      false,
    );
  }
  try {
    const r = await run(req, router, body, false);
    if (body.stream === true && r.stream)
      return new Response(r.stream, { headers: { ...sseHeaders, ...info(r) } });
    return Response.json(
      {
        ...r.json,
        router: { ...r.json.router, offer: r.offer.id, attempts: r.attempts },
      },
      { headers: info(r) },
    );
  } catch (e) {
    return errorResponse(e, false);
  }
}

export async function messages(
  req: Request,
  router: Router,
): Promise<Response> {
  let a: any;
  try {
    a = await req.json();
    if (!Array.isArray(a.messages)) throw new Error("messages requis");
  } catch (e: any) {
    return errorResponse(
      { status: 400, message: `corps invalide : ${e.message}` },
      true,
    );
  }
  try {
    const r = await run(req, router, anthropicToOpenAI(a) as Body, true);
    const h = info(r);
    if (a.stream === true && r.stream)
      return new Response(anthropicStream(r.stream, a.model ?? r.offer.id), {
        headers: { ...sseHeaders, ...h },
      });
    return Response.json(openAIToAnthropic(r.json, a.model ?? r.offer.id), {
      headers: h,
    });
  } catch (e) {
    return errorResponse(e, true);
  }
}

export async function countTokens(req: Request): Promise<Response> {
  const a: any = await req.json().catch(() => ({}));
  return Response.json({
    input_tokens: Math.ceil(
      JSON.stringify([a.system, a.messages, a.tools]).length / 4,
    ),
  });
}

export async function models(router: Router): Promise<Response> {
  const cat = await router.catalog();
  const now = Math.floor(Date.now() / 1000);
  const per = (n?: number) => (n === undefined ? undefined : String(n / 1e6));
  return Response.json({
    object: "list",
    data: [
      ...VIRTUAL.map((id) => ({
        id,
        object: "model",
        created: now,
        owned_by: "aphrody-router",
      })),
      ...cat.offers.map((o) => ({
        id: o.id,
        object: "model",
        created: now,
        owned_by: o.provider,
        context_length: o.context,
        max_output_tokens: o.maxOutput,
        supports_tools: o.tools,
        supports_vision: o.vision,
        pricing: { prompt: per(o.priceIn), completion: per(o.priceOut) },
        arena_rating: o.arena,
      })),
    ],
  });
}
