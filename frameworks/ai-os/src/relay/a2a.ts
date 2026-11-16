// A2A 1.0 over the JSON-RPC binding (a2aproject/A2A v1.0.1: docs/specification.md §3, §5.4, §9; specification/a2a.proto).
// Each SendMessage creates a task (Task) served by a relay tool (metadata.skill, gemini_ask by default):
//   SendMessage (bloquant, ou configuration.returnImmediately), SendStreamingMessage et SubscribeToTask en SSE
//   (Task, then TaskStatusUpdateEvent / TaskArtifactUpdateEvent, stream closed at the terminal state), GetTask, ListTasks,
//   CancelTask. Push notifications and extended card: dedicated A2A errors (-32003, -32007).
// A2A-Version header (or query parameter): absent = 0.3 (§3.6.2), major other than 1 -> VersionNotSupportedError.
// In-process task memory (500 at most, the oldest finished ones leave first).
import {
  call,
  dispatch,
  fail,
  ok,
  type Req,
  type Res,
  text,
  VERSION,
} from "./protocols.ts";
import { TOOLS } from "./tools.ts";
import { a2aSecurity } from "./oauth.ts";

export const A2A_VERSION = "1.0";

/** Tools exposed as A2A skills: the card and SendMessage read the same list. */
export const A2A_SKILLS = [
  "gemini_ask",
  "claude_ask",
  "agy_ask",
  "gemini_review",
  "agent_run",
  "llm_ask",
  "session_send",
];

// JSON-RPC codes of A2A errors (§5.4) and google.rpc.ErrorInfo reasons.
export const A2A_ERRORS = {
  TaskNotFound: [-32001, "TASK_NOT_FOUND"],
  TaskNotCancelable: [-32002, "TASK_NOT_CANCELABLE"],
  PushNotificationNotSupported: [-32003, "PUSH_NOTIFICATION_NOT_SUPPORTED"],
  UnsupportedOperation: [-32004, "UNSUPPORTED_OPERATION"],
  ContentTypeNotSupported: [-32005, "CONTENT_TYPE_NOT_SUPPORTED"],
  ExtendedAgentCardNotConfigured: [
    -32007,
    "EXTENDED_AGENT_CARD_NOT_CONFIGURED",
  ],
  VersionNotSupported: [-32009, "VERSION_NOT_SUPPORTED"],
} as const;

const a2aError = (
  id: Req["id"],
  kind: keyof typeof A2A_ERRORS,
  message: string,
  metadata: Record<string, string> = {},
) =>
  fail(id, A2A_ERRORS[kind][0], message, [
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: A2A_ERRORS[kind][1],
      domain: "a2a-protocol.org",
      metadata,
    },
  ]);
const badRequest = (id: Req["id"], field: string, description: string) =>
  fail(id, -32602, "Invalid parameters", [
    {
      "@type": "type.googleapis.com/google.rpc.BadRequest",
      fieldViolations: [{ field, description }],
    },
  ]);

/** Requested version (Major.Minor): empty = 0.3; accepted if the major is 1 (the patch is ignored, §3.6). */
export const versionSupported = (v: string | null | undefined) =>
  (v?.trim() || "0.3").split(".")[0] === A2A_VERSION.split(".")[0];

type State =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_AUTH_REQUIRED";
const TERMINAL: State[] = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
];
type Part = {
  text?: string;
  raw?: string;
  url?: string;
  data?: unknown;
  mediaType?: string;
  filename?: string;
  metadata?: Record<string, unknown>;
};
type Message = {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: "ROLE_USER" | "ROLE_AGENT";
  parts: Part[];
  metadata?: Record<string, unknown>;
};
type Task = {
  id: string;
  contextId: string;
  status: { state: State; message?: Message; timestamp: string };
  artifacts: { artifactId: string; name?: string; parts: Part[] }[];
  history: Message[];
  metadata: Record<string, unknown>;
};
type Event =
  | { task: Task }
  | {
      statusUpdate: {
        taskId: string;
        contextId: string;
        status: Task["status"];
      };
    }
  | {
      artifactUpdate: {
        taskId: string;
        contextId: string;
        artifact: Task["artifacts"][number];
        append: boolean;
        lastChunk: boolean;
      };
    };
/** done: resolved at the terminal state (completion, failure or cancellation). */
type Entry = {
  task: Task;
  done: Promise<void>;
  end: () => void;
  subs: Set<(e: Event) => void>;
};

const tasks = new Map<string, Entry>();
/** contextId -> Gemini conversation (multi-turn, §3.4.1). */
const chats = new Map<string, string>();
const MAX_TASKS = 500;

const isTerminal = (s: State) => TERMINAL.includes(s);
const agentMessage = (t: Task, s: string): Message => ({
  messageId: crypto.randomUUID(),
  contextId: t.contextId,
  taskId: t.id,
  role: "ROLE_AGENT",
  parts: [{ text: s, mediaType: "text/plain" }],
});
/** Copy served to the client: history bounded by historyLength (0 = no message, absent = all), optional artifacts. */
const view = (t: Task, historyLength?: number, artifacts = true) => {
  const n = historyLength ?? t.history.length;
  return {
    ...structuredClone(t),
    history: n > 0 ? t.history.slice(-n) : [],
    artifacts: artifacts ? t.artifacts : [],
  };
};
const emit = (e: Entry, ev: Event) => {
  for (const f of e.subs) f(ev);
};
const setStatus = (e: Entry, state: State, msg?: string) => {
  const t = e.task;
  t.status = {
    state,
    ...(msg ? { message: agentMessage(t, msg) } : {}),
    timestamp: new Date().toISOString(),
  };
  if (t.status.message) t.history.push(t.status.message);
  emit(e, {
    statusUpdate: { taskId: t.id, contextId: t.contextId, status: t.status },
  });
  if (isTerminal(state)) e.end();
};
const prune = () => {
  if (tasks.size < MAX_TASKS) return;
  for (const [id, e] of tasks)
    if (isTerminal(e.task.status.state)) {
      tasks.delete(id);
      if (tasks.size < MAX_TASKS) return;
    }
};

/** Message text: text parts, data (JSON), url (reference), raw text (base64); other raw -> null (unsupported type). */
function promptOf(parts: Part[]): { prompt: string } | { mediaType: string } {
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p.text === "string") out.push(p.text);
    else if (p.data !== undefined) out.push(JSON.stringify(p.data));
    else if (typeof p.url === "string")
      out.push(`[${p.filename ?? "file"}] ${p.url}`);
    else if (typeof p.raw === "string") {
      const mt = p.mediaType ?? "application/octet-stream";
      if (!/^text\/|^application\/(json|xml)/.test(mt))
        return { mediaType: mt };
      out.push(Buffer.from(p.raw, "base64").toString("utf8"));
    }
  }
  return { prompt: out.join("\n") };
}

function argsFor(skill: string, m: Message, prompt: string, chat?: string) {
  const md = (m.metadata ?? {}) as Record<string, any>;
  switch (skill) {
    case "gemini_review":
      return { title: md.title ?? "A2A", content: prompt };
    case "agent_run":
      return { task: prompt, ...(md.model ? { model: md.model } : {}) };
    case "llm_ask":
      return { model: md.model, prompt };
    case "session_send":
      // A2A peer messaging: metadata {from, to, reply_to?}; the task completes with the recipient reply.
      return {
        from: md.from,
        to: md.to,
        text: prompt,
        ...(md.reply_to ? { reply_to: md.reply_to } : {}),
        wait_s: Number(md.wait_s ?? 600),
      };
    case "claude_ask":
    case "agy_ask":
      return { prompt, ...(md.model ? { model: md.model } : {}) };
    default:
      return {
        prompt,
        ...((md.chat ?? chat) ? { chat: md.chat ?? chat } : {}),
      };
  }
}

type Start = { entry: Entry } | { error: Res };

/** Validates SendMessageRequest and starts the task; execution continues in the background. */
function start(r: Req): Start {
  const p = r.params ?? {};
  const m = p.message as Message | undefined;
  if (!m || typeof m !== "object")
    return { error: badRequest(r.id, "message", "message is required") };
  if (typeof m.messageId !== "string" || !m.messageId)
    return {
      error: badRequest(r.id, "message.messageId", "messageId is required"),
    };
  if (m.role !== "ROLE_USER")
    return {
      error: badRequest(
        r.id,
        "message.role",
        "client messages must use ROLE_USER",
      ),
    };
  if (!Array.isArray(m.parts) || !m.parts.length)
    return {
      error: badRequest(r.id, "message.parts", "At least one part is required"),
    };
  const bad = m.parts.findIndex(
    (x) =>
      !x ||
      typeof x !== "object" ||
      ["text", "raw", "url", "data"].filter((k) => k in x).length !== 1,
  );
  if (bad >= 0)
    return {
      error: badRequest(
        r.id,
        `message.parts[${bad}]`,
        "exactly one of text, raw, url, data",
      ),
    };
  const md = { ...(p.metadata ?? {}), ...(m.metadata ?? {}) } as Record<
    string,
    any
  >;
  const skill = String(md.skill ?? "gemini_ask");
  if (!A2A_SKILLS.includes(skill))
    return {
      error: badRequest(
        r.id,
        "message.metadata.skill",
        `unknown skill: ${skill}`,
      ),
    };
  if (skill === "llm_ask" && !md.model)
    return {
      error: badRequest(
        r.id,
        "message.metadata.model",
        "llm_ask needs provider/model",
      ),
    };
  if (skill === "session_send" && (!md.from || !md.to))
    return {
      error: badRequest(
        r.id,
        !md.from ? "message.metadata.from" : "message.metadata.to",
        "session_send needs metadata.from (your session) and metadata.to (recipient)",
      ),
    };
  const pr = promptOf(m.parts);
  if ("mediaType" in pr)
    return {
      error: a2aError(
        r.id,
        "ContentTypeNotSupported",
        `media type not supported: ${pr.mediaType}`,
        {
          mediaType: pr.mediaType,
        },
      ),
    };
  if (m.taskId) {
    const prev = tasks.get(m.taskId);
    if (!prev)
      return {
        error: a2aError(r.id, "TaskNotFound", "Task not found", {
          taskId: m.taskId,
        }),
      };
    if (isTerminal(prev.task.status.state))
      return {
        error: a2aError(
          r.id,
          "UnsupportedOperation",
          "task is in a terminal state",
          {
            taskId: m.taskId,
          },
        ),
      };
    // No tool asks for more input (INPUT_REQUIRED): a running task receives no other message.
    return {
      error: a2aError(
        r.id,
        "UnsupportedOperation",
        "task does not accept messages while working",
        {
          taskId: m.taskId,
        },
      ),
    };
  }
  if (m.contextId !== undefined && typeof m.contextId !== "string")
    return {
      error: badRequest(
        r.id,
        "message.contextId",
        "contextId must be a string",
      ),
    };
  prune();
  const contextId = m.contextId || crypto.randomUUID();
  const task: Task = {
    id: crypto.randomUUID(),
    contextId,
    status: {
      state: "TASK_STATE_SUBMITTED",
      timestamp: new Date().toISOString(),
    },
    artifacts: [],
    history: [],
    metadata: { skill },
  };
  task.history.push({ ...m, contextId, taskId: task.id });
  const { promise, resolve } = Promise.withResolvers<void>();
  const entry: Entry = { task, done: promise, end: resolve, subs: new Set() };
  tasks.set(task.id, entry);
  // Execution on the next tick: the client first receives the SUBMITTED task (SSE stream, returnImmediately).
  queueMicrotask(async () => {
    if (isTerminal(task.status.state)) return;
    setStatus(entry, "TASK_STATE_WORKING");
    let v: any;
    try {
      v = await call(skill, argsFor(skill, m, pr.prompt, chats.get(contextId)));
    } catch (e: any) {
      if (!isTerminal(task.status.state))
        setStatus(entry, "TASK_STATE_FAILED", String(e?.message ?? e));
      return;
    }
    if (isTerminal(task.status.state)) return; // cancelled during execution
    if (typeof v?.chat === "string") chats.set(contextId, v.chat);
    task.metadata = {
      skill,
      ...(v?.engine ? { engine: v.engine } : {}),
      ...(v?.chat ? { chat: v.chat } : {}),
      ...(typeof v?.ms === "number" ? { ms: v.ms } : {}),
    };
    const artifact = {
      artifactId: crypto.randomUUID(),
      name: skill,
      parts: [{ text: text(v), mediaType: "text/plain" }],
    };
    task.artifacts.push(artifact);
    emit(entry, {
      artifactUpdate: {
        taskId: task.id,
        contextId,
        artifact,
        append: false,
        lastChunk: true,
      },
    });
    setStatus(entry, "TASK_STATE_COMPLETED");
  });
  return { entry };
}

const historyLength = (src: any) => {
  const n = src?.historyLength;
  return typeof n === "number" && n >= 0 ? Math.floor(n) : undefined;
};

/** A2A methods without a stream (single JSON-RPC response). */
export async function a2aRpc(r: Req): Promise<Res | null> {
  const p = r.params ?? {};
  switch (r.method) {
    case "SendMessage": {
      const cfg = p.configuration ?? {};
      if (cfg.taskPushNotificationConfig)
        return a2aError(
          r.id,
          "PushNotificationNotSupported",
          "push notifications are not supported",
        );
      const s = start(r);
      if ("error" in s) return s.error;
      if (!cfg.returnImmediately) await s.entry.done;
      return ok(r.id, { task: view(s.entry.task, historyLength(cfg)) });
    }
    case "GetTask": {
      if (typeof p.id !== "string" || !p.id)
        return badRequest(r.id, "id", "id is required");
      const e = tasks.get(p.id);
      if (!e)
        return a2aError(r.id, "TaskNotFound", "Task not found", {
          taskId: p.id,
        });
      return ok(r.id, view(e.task, historyLength(p)));
    }
    case "ListTasks": {
      const size = p.pageSize ?? 50;
      if (!Number.isInteger(size) || size < 1 || size > 100)
        return badRequest(
          r.id,
          "pageSize",
          "pageSize must be between 1 and 100",
        );
      const offset = p.pageToken
        ? Number(Buffer.from(String(p.pageToken), "base64url").toString())
        : 0;
      if (!Number.isInteger(offset) || offset < 0)
        return badRequest(r.id, "pageToken", "invalid pageToken");
      const after = p.statusTimestampAfter
        ? Date.parse(p.statusTimestampAfter)
        : undefined;
      const all = [...tasks.values()]
        .map((e) => e.task)
        .filter(
          (t) =>
            (!p.contextId || t.contextId === p.contextId) &&
            (!p.status ||
              p.status === "TASK_STATE_UNSPECIFIED" ||
              t.status.state === p.status) &&
            (after === undefined || Date.parse(t.status.timestamp) >= after),
        )
        .sort((a, b) => b.status.timestamp.localeCompare(a.status.timestamp));
      const page = all.slice(offset, offset + size);
      const next =
        offset + size < all.length
          ? Buffer.from(String(offset + size)).toString("base64url")
          : "";
      return ok(r.id, {
        tasks: page.map((t) =>
          view(t, historyLength(p), p.includeArtifacts === true),
        ),
        nextPageToken: next,
        pageSize: page.length,
        totalSize: all.length,
      });
    }
    case "CancelTask": {
      if (typeof p.id !== "string" || !p.id)
        return badRequest(r.id, "id", "id is required");
      const e = tasks.get(p.id);
      if (!e)
        return a2aError(r.id, "TaskNotFound", "Task not found", {
          taskId: p.id,
        });
      if (isTerminal(e.task.status.state))
        return a2aError(r.id, "TaskNotCancelable", "Task cannot be canceled", {
          taskId: p.id,
          state: e.task.status.state,
        });
      setStatus(e, "TASK_STATE_CANCELED");
      return ok(r.id, view(e.task));
    }
    case "SendStreamingMessage":
    case "SubscribeToTask":
      // Hors HTTP (lot JSON-RPC) : pas de flux SSE possible.
      return fail(
        r.id,
        -32600,
        `${r.method} requires a single request over HTTP (SSE)`,
      );
    case "CreateTaskPushNotificationConfig":
    case "GetTaskPushNotificationConfig":
    case "ListTaskPushNotificationConfigs":
    case "DeleteTaskPushNotificationConfig":
      return a2aError(
        r.id,
        "PushNotificationNotSupported",
        "push notifications are not supported",
      );
    case "GetExtendedAgentCard":
      return a2aError(
        r.id,
        "ExtendedAgentCardNotConfigured",
        "no extended agent card",
      );
    default:
      return r.id === undefined
        ? null
        : fail(r.id, -32601, "Method not found", { method: r.method });
  }
}

const sse = (id: Req["id"], first: (Event | Res)[], e?: Entry) => {
  const enc = new TextEncoder();
  const frame = (x: Event | Res) =>
    enc.encode(`data: ${JSON.stringify("jsonrpc" in x ? x : ok(id, x))}\n\n`);
  let sub: ((ev: Event) => void) | undefined;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const x of first) c.enqueue(frame(x));
        if (!e || isTerminal(e.task.status.state)) return c.close();
        sub = (ev) => {
          c.enqueue(frame(ev));
          if (
            "statusUpdate" in ev &&
            isTerminal(ev.statusUpdate.status.state)
          ) {
            e.subs.delete(sub!);
            c.close();
          }
        };
        e.subs.add(sub);
      },
      cancel() {
        if (sub) e?.subs.delete(sub);
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    },
  );
};

/** POST /a2a: version (§3.6.2), JSON-RPC body, SSE stream for SendStreamingMessage and SubscribeToTask (§9.4.2, §9.4.6). */
export async function a2aHttp(req: Request): Promise<Response> {
  const raw = await req.text();
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json(fail(null, -32700, "Invalid JSON payload"));
  }
  const version =
    req.headers.get("a2a-version") ??
    new URL(req.url).searchParams.get("A2A-Version");
  if (!versionSupported(version)) {
    const err = (b: any) =>
      a2aError(
        b?.id ?? null,
        "VersionNotSupported",
        "A2A version not supported",
        {
          requested: version?.trim() || "0.3",
          supported: A2A_VERSION,
        },
      );
    return Response.json(
      Array.isArray(body) && body.length ? body.map(err) : err(body),
    );
  }
  const streaming =
    body &&
    !Array.isArray(body) &&
    body.jsonrpc === "2.0" &&
    ["SendStreamingMessage", "SubscribeToTask"].includes(body.method);
  if (!streaming) {
    const out = await dispatch(body, a2aRpc);
    return out === null
      ? new Response(null, { status: 202 })
      : Response.json(out);
  }
  const r = body as Req;
  if (r.method === "SendStreamingMessage") {
    if (r.params?.configuration?.taskPushNotificationConfig)
      return sse(r.id, [
        a2aError(
          r.id,
          "PushNotificationNotSupported",
          "push notifications are not supported",
        ),
      ]);
    const s = start(r);
    if ("error" in s) return sse(r.id, [s.error]);
    return sse(
      r.id,
      [{ task: view(s.entry.task, historyLength(r.params?.configuration)) }],
      s.entry,
    );
  }
  const id = r.params?.id;
  const e = typeof id === "string" ? tasks.get(id) : undefined;
  if (!e)
    return sse(r.id, [
      a2aError(r.id, "TaskNotFound", "Task not found", { taskId: String(id) }),
    ]);
  if (isTerminal(e.task.status.state))
    return sse(r.id, [
      a2aError(r.id, "UnsupportedOperation", "task is in a terminal state", {
        taskId: id,
      }),
    ]);
  return sse(r.id, [{ task: view(e.task) }], e);
}

export const agentCard = (url: string) => ({
  name: "aphrody-relay",
  description:
    "Relay between Claude Code and Gemini (gemini.google.com or Gemini CLI), with read-only access to the VPS fleet and gcloud.",
  supportedInterfaces: [
    {
      url: `${url}/a2a`,
      protocolBinding: "JSONRPC",
      protocolVersion: A2A_VERSION,
    },
  ],
  provider: { organization: "Aphrody", url: "https://aphrody.com" },
  version: VERSION,
  capabilities: {
    streaming: true,
    pushNotifications: false,
    extendedAgentCard: false,
  },
  ...a2aSecurity(url),
  defaultInputModes: ["text/plain", "application/json"],
  defaultOutputModes: ["text/plain"],
  skills: TOOLS.filter((t) => A2A_SKILLS.includes(t.name)).map((t) => ({
    id: t.name,
    name: t.name,
    description: t.description,
    tags: ["llm"],
    inputModes: ["text/plain", "application/json"],
    outputModes: ["text/plain"],
  })),
});
