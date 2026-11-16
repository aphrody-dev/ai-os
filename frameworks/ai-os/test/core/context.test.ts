import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Context,
  hashEmbedder,
  init,
  persona,
  renderContext,
  Skills,
} from "../../src/core/index";

const tmp = (p: string) => join(mkdtempSync(join(tmpdir(), p)), "c.sqlite");

test("context: multi-head select, masks, budget, redaction, kv-cache", async () => {
  let calls = 0;
  const base = hashEmbedder();
  const emb = {
    id: base.id,
    embed: async (t: string[]) => ((calls += t.length), base.embed(t)),
  };
  const ctx = new Context(tmp("agent-ctx-"), emb);
  const day = 86_400_000;
  const now = Date.now();
  await ctx.ingest(
    {
      id: "m:1",
      source: "memory",
      scope: "user",
      text: "deploy the website with bun build then rsync to prd",
    },
    now - 30 * day,
  );
  await ctx.ingest(
    {
      id: "m:2",
      source: "memory",
      scope: "user",
      text: "the user prefers French answers",
    },
    now,
  );
  await ctx.ingest(
    {
      id: "m:3",
      source: "memory",
      scope: "team:secret",
      text: "deploy token ghp_abcdefghijklmnop1234",
    },
    now,
  );
  await ctx.ingest(
    {
      id: "c:1",
      source: "code",
      scope: "repo",
      text: "fn deploy_site()",
      symbols: ["deploy_site", "rsync_prd"],
    },
    now,
  );
  const before = calls;
  await ctx.ingest(
    {
      id: "m:1",
      source: "memory",
      scope: "user",
      text: "deploy the website with bun build then rsync to prd",
    },
    now - 30 * day,
  );
  expect(calls).toBe(before); // unchanged text: KV-cache hit, no re-embedding

  const top = await ctx.select("how do I deploy the website", {
    scopes: ["user"],
    now,
  });
  expect(top[0]?.id).toBe("m:1");
  expect(top.every((s) => s.scope === "user")).toBe(true); // mask
  expect(Object.keys(top[0]!.heads).sort()).toEqual([
    "lexical",
    "recency",
    "semantic",
  ]);

  const all = await ctx.select("deploy token", { now });
  expect(all.find((s) => s.id === "m:3")?.text).not.toContain(
    "ghp_abcdefghijklmnop1234",
  ); // secret redaction on output

  const st = await ctx.select("call deploy_site", {
    sources: ["code", "memory"],
    now,
  });
  expect(st.find((s) => s.id === "c:1")?.heads.structural).toBeGreaterThan(0.3);

  const tiny = await ctx.select("deploy", { budgetTokens: 12, now });
  expect(tiny.reduce((a, s) => a + s.tokens, 0)).toBeLessThanOrEqual(12);
  expect(renderContext(top)).toContain("## memory");
  ctx.close();
});

test("home: init templates, persona prefix; skills indexed in context", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-home-"));
  const made = await init(home);
  expect(made.map((p) => p.split(/[\\/]/).pop()).sort()).toEqual([
    "AGENTS.md",
    "HEARTBEAT.md",
    "IDENTITY.md",
    "MEMORY.md",
    "SOUL.md",
    "USER.md",
    "config.json",
  ]);
  expect(await init(home)).toEqual([]); // idempotent
  const p = await persona(home);
  expect(p).toContain("SOUL.md");
  expect(p).toContain("## Voice");
  const ctx = new Context(join(home, "memory.sqlite"));
  const skills = new Skills(join(home, "skills"), ctx);
  await skills.create(
    "Reverse words",
    "Reverse the lines of a text file",
    "1. read 2. reverse 3. write",
  );
  const hit = await ctx.select("reverse lines in a file", {
    sources: ["skill"],
  });
  expect(hit[0]?.id).toBe("skill:reverse-words");
  ctx.close();
});

test("context: scope mask applies before LIMIT (no starvation by newer out-of-scope rows)", async () => {
  const ctx = new Context(tmp("agent-ctx-scope-"), undefined);
  const now = Date.now();
  await ctx.ingest(
    {
      id: "old",
      source: "memory",
      scope: "team:a",
      text: "deploy runbook for prd",
    },
    now - 10_000,
  );
  await ctx.ingest(
    Array.from({ length: 50 }, (_, i) => ({
      id: `n${i}`,
      source: "doc",
      scope: "other",
      text: `noise ${i}`,
    })),
    now,
  );
  await ctx.ingest(
    { id: "near", source: "memory", scope: "teams", text: "not team" },
    now - 20_000,
  );
  expect(ctx.list({ scopes: ["team"] }, 5).map((e) => e.id)).toEqual(["old"]);
  const plan = ctx.db
    .query(
      "EXPLAIN QUERY PLAN SELECT * FROM entries WHERE scope = ? OR (scope >= ? AND scope < ?)",
    )
    .all("team", "team:", "team;")
    .map((r: any) => r.detail)
    .join(" ");
  expect(plan).toContain("entries_scope_at");
  expect(ctx.list({ scopes: ["team:a"], sources: ["doc"] }, 5)).toEqual([]);
  expect(ctx.list({ scopes: ["*"] }, 3).length).toBe(3);
  expect(
    ctx.list({ allow: (e) => e.id === "old" }, 1).map((e) => e.id),
  ).toEqual(["old"]);
  const hit = await ctx.select("deploy runbook", {
    scopes: ["team"],
    candidates: 5,
  });
  expect(hit.map((s) => s.id)).toEqual(["old"]);
  ctx.close();
});
