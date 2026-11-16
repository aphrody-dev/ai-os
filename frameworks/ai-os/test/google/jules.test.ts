// Absorbed Jules client (src/google/jules, from google-labs-code/jules-sdk core) against a local fake of the
// Jules REST API (v1alpha): API key and OAuth modes, automated run -> PR, session listing, relay tools.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "jules-home-"));
process.env.JULES_HOME = home;
const { connect, MissingApiKeyError } =
  await import("../../src/google/jules/index.ts");

type Seen = { method: string; path: string; headers: Headers; body: any };
const seen: Seen[] = [];
let polls = 0;
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";

const SESSION = {
  name: "sessions/s1",
  id: "s1",
  title: "Fix it",
  prompt: "Fix it",
  sourceContext: {
    source: "sources/github/aphrody-labs/src",
    githubRepoContext: { startingBranch: "main" },
  },
  createTime: "2026-11-13T00:00:00Z",
  updateTime: "2026-11-13T00:00:00Z",
  url: "https://jules.google.com/session/s1",
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const path = u.pathname.replace(/^\/v1alpha\//, "");
      const body = req.method === "POST" ? await req.json() : null;
      seen.push({ method: req.method, path, headers: req.headers, body });
      if (path === "sources/github/aphrody-labs/src")
        return Response.json({
          name: "sources/github/aphrody-labs/src",
          id: "github/aphrody-labs/src",
          githubRepo: {
            owner: "aphrody-labs",
            repo: "src",
            defaultBranch: { displayName: "main" },
          },
        });
      if (path === "sessions" && req.method === "POST")
        return Response.json({ ...SESSION, state: "QUEUED" });
      if (path === "sessions" && req.method === "GET")
        return Response.json({
          sessions: [{ ...SESSION, state: "COMPLETED" }],
        });
      if (path === "sessions/s1") {
        polls++;
        return Response.json(
          polls < 2
            ? { ...SESSION, state: "IN_PROGRESS" }
            : {
                ...SESSION,
                state: "COMPLETED",
                outputs: [
                  {
                    pullRequest: {
                      url: "https://github.com/aphrody-labs/src/pull/1",
                      title: "Fix it",
                      description: "",
                    },
                  },
                ],
              },
        );
      }
      return Response.json(
        { error: { code: 404, message: "not found" } },
        { status: 404 },
      );
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}/v1alpha`;
});
afterAll(() => {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

describe("jules: absorbed core", () => {
  test("automated run sends AUTO_CREATE_PR on the GitHub source and resolves to the PR", async () => {
    seen.length = 0;
    polls = 0;
    const j = connect({
      apiKey: "jk",
      baseUrl,
      config: { pollingIntervalMs: 5 },
    });
    const run = await j.run({
      prompt: "Fix it",
      source: { github: "aphrody-labs/src", baseBranch: "main" },
    });
    expect(run.id).toBe("s1");
    const post = seen.find(
      (s) => s.method === "POST" && s.path === "sessions",
    )!;
    expect(post.headers.get("x-goog-api-key")).toBe("jk");
    expect(post.body).toMatchObject({
      prompt: "Fix it",
      automationMode: "AUTO_CREATE_PR",
      requirePlanApproval: false,
      sourceContext: {
        source: "sources/github/aphrody-labs/src",
        githubRepoContext: { startingBranch: "main" },
      },
    });
    const out = await run.result();
    expect(out.state).toBe("completed");
    expect(out.pullRequest?.url).toBe(
      "https://github.com/aphrody-labs/src/pull/1",
    );
  });

  test("OAuth mode (Aphrody): authHeaders replace the API key", async () => {
    seen.length = 0;
    const j = connect({
      baseUrl,
      authHeaders: async () => ({
        Authorization: "Bearer ya29.t",
        "X-Goog-User-Project": "aphrody",
      }),
    });
    const list = [];
    for await (const s of j.sessions({ limit: 5 })) list.push(s);
    expect(list.map((s) => s.id)).toEqual(["s1"]);
    const h = seen.at(-1)!.headers;
    expect(h.get("authorization")).toBe("Bearer ya29.t");
    expect(h.get("x-goog-user-project")).toBe("aphrody");
    expect(h.get("x-goog-api-key")).toBeNull();
  });

  test("no credentials -> MissingApiKeyError (upstream contract)", async () => {
    const saved = process.env.JULES_API_KEY;
    delete process.env.JULES_API_KEY;
    try {
      const j = connect({ baseUrl });
      const it = j.sessions({ limit: 1 })[Symbol.asyncIterator]();
      await expect(it.next()).rejects.toBeInstanceOf(MissingApiKeyError);
    } finally {
      if (saved !== undefined) process.env.JULES_API_KEY = saved;
    }
  });
});

describe("jules: relay tools", () => {
  test("jules_run / jules_status / jules_sessions are registered and readOnly where they read", async () => {
    const { toolByName } = await import("../../src/relay/tools.ts");
    expect(toolByName.get("jules_run")?.readOnly).toBe(false);
    expect(toolByName.get("jules_status")?.readOnly).toBe(true);
    expect(toolByName.get("jules_sessions")?.readOnly).toBe(true);
  });
});
