// Extracted from third_party/vercel-ai (Apache-2.0):
// - packages/ai/src/ui-message-stream/ui-message-stream-headers.ts
// - packages/ai/src/ui-message-stream/json-to-sse-transform-stream.ts
// - packages/ai/src/ui-message-stream/create-ui-message-stream-response.ts

export const UI_MESSAGE_STREAM_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-vercel-ai-ui-message-stream": "v1",
  "x-accel-buffering": "no",
} as const;

export class JsonToSseTransformStream extends TransformStream<unknown, string> {
  constructor() {
    super({
      transform(part, controller) {
        controller.enqueue(`data: ${JSON.stringify(part)}\n\n`);
      },
      flush(controller) {
        controller.enqueue("data: [DONE]\n\n");
      },
    });
  }
}

export function createUIMessageStreamResponse(
  stream: ReadableStream<unknown>,
  init?: ResponseInit,
): Response {
  const sse = stream
    .pipeThrough(new JsonToSseTransformStream())
    .pipeThrough(new TextEncoderStream());
  return new Response(sse, {
    ...init,
    headers: {
      ...UI_MESSAGE_STREAM_HEADERS,
      ...(init?.headers ?? {}),
    },
  });
}

// Extracted from vercel-labs/json-render (Apache-2.0):
// RFC 6902 JSON Patch diff/apply + Generative UI UISpec validation for streaming UI updates.
export type JsonPatch =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

export type UIElement = {
  type: string;
  props: Record<string, unknown>;
  children?: string[];
};

export type UISpec = {
  root: string;
  elements: Record<string, UIElement>;
  state?: Record<string, unknown>;
};

const escapePointer = (token: string) =>
  token.replace(/~/g, "~0").replace(/\//g, "~1");

const unescapePointer = (token: string) =>
  token.replace(/~1/g, "/").replace(/~0/g, "~");

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function arraysEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function diffToPatches(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
  basePath = "",
): JsonPatch[] {
  const patches: JsonPatch[] = [];
  for (const key of Object.keys(newObj)) {
    const path = `${basePath}/${escapePointer(key)}`;
    const oldVal = oldObj[key];
    const newVal = newObj[key];
    if (!(key in oldObj)) {
      patches.push({ op: "add", path, value: newVal });
    } else if (isPlainObject(oldVal) && isPlainObject(newVal)) {
      patches.push(...diffToPatches(oldVal, newVal, path));
    } else if (Array.isArray(oldVal) && Array.isArray(newVal)) {
      if (!arraysEqual(oldVal, newVal))
        patches.push({ op: "replace", path, value: newVal });
    } else if (oldVal !== newVal) {
      patches.push({ op: "replace", path, value: newVal });
    }
  }
  for (const key of Object.keys(oldObj)) {
    if (!(key in newObj))
      patches.push({ op: "remove", path: `${basePath}/${escapePointer(key)}` });
  }
  return patches;
}

export function applyPatch<T extends Record<string, unknown>>(
  doc: T,
  patches: JsonPatch[],
): T {
  const root = structuredClone(doc) as Record<string, unknown>;
  for (const p of patches) {
    const parts = p.path.split("/").slice(1).map(unescapePointer);
    if (!parts.length) continue;
    let cur: Record<string, unknown> = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      if (!isPlainObject(cur[seg])) cur[seg] = {};
      cur = cur[seg] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1]!;
    if (p.op === "remove") delete cur[last];
    else cur[last] = structuredClone(p.value);
  }
  return root as T;
}

export function validateUISpec(
  spec: unknown,
  allowedTypes?: Set<string> | string[],
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(spec))
    return { ok: false, errors: ["spec must be an object"] };
  if (typeof spec.root !== "string" || !spec.root)
    errors.push("spec.root must be a non-empty string");
  if (!isPlainObject(spec.elements)) {
    errors.push("spec.elements must be an object");
    return { ok: false, errors };
  }
  const elements = spec.elements as Record<string, unknown>;
  if (typeof spec.root === "string" && !(spec.root in elements))
    errors.push(`missing root element: ${spec.root}`);
  const allowed = allowedTypes
    ? allowedTypes instanceof Set
      ? allowedTypes
      : new Set(allowedTypes)
    : null;
  for (const [id, raw] of Object.entries(elements)) {
    if (!isPlainObject(raw)) {
      errors.push(`element ${id} must be an object`);
      continue;
    }
    if (typeof raw.type !== "string" || !raw.type)
      errors.push(`element ${id} missing string type`);
    else if (allowed && !allowed.has(raw.type))
      errors.push(`element ${id} uses disallowed type: ${raw.type}`);
    if (Array.isArray(raw.children)) {
      for (const c of raw.children) {
        if (typeof c !== "string" || !(c in elements))
          errors.push(`element ${id} references missing child: ${String(c)}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
