import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  osLlmSpec,
  osRagQuery,
  osRagUpsert,
  osResolveVfs,
  osSys1Decide,
  osUname,
  osWorldState,
  osWorldStep,
} from "../../src/core/cabi";

test("ai-os unified C ABI contract: uname, FHS VFS, LLM spec, RAG, World Model, System 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-os-cabi-"));
  const dbPath = join(dir, "os.sqlite");
  try {
    const u = osUname();
    expect(u.os).toBe("aphrody-ai-os");
    expect(u.fhs.dev).toContain("/dev/llm");
    expect(u.fhs.dev).toContain("/dev/world");
    expect(u.fhs.dev).toContain("/dev/sys1");

    const vfs = osResolveVfs(dir, "/dev/world");
    expect(vfs.device).toBe("world");
    expect(vfs.readonly).toBe(false);
    expect(() => osResolveVfs(dir, "/etc/../secret")).toThrow();

    const spec = osLlmSpec() as {
      discovery: string;
      hardcoded_models: boolean;
    };
    expect(spec.discovery).toBe("runtime");
    expect(spec.hardcoded_models).toBe(false);

    await osRagUpsert(dbPath, {
      id: "doc-1",
      source: "doc",
      scope: "global",
      title: "Kernel",
      text: "Aphrody AI OS POSIX VFS and System 1 decision router",
    });
    const hits = await osRagQuery(dbPath, { query: "POSIX VFS", k: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.id).toBe("doc-1");

    const okStep = osWorldStep(dbPath, {
      actor: "agent",
      action: "write",
      target: "/etc/ai-os/policy",
      predicted: { ok: true },
      observed: { ok: true },
    });
    expect(okStep.surprise).toBe(0);
    expect(okStep.escalate_sys2).toBe(false);

    const errStep = osWorldStep(dbPath, {
      actor: "agent",
      action: "deploy",
      target: "service:prd",
      predicted: { status: "healthy" },
      observed: { status: "degraded" },
    });
    expect(errStep.surprise).toBe(1);
    expect(errStep.escalate_sys2).toBe(true);

    const st = osWorldState(dbPath, "service:prd") as {
      entity: string;
      state: { status: string };
    };
    expect(st.entity).toBe("service:prd");
    expect(st.state.status).toBe("degraded");

    expect(
      osSys1Decide(dbPath, {
        action: "read_file",
        risk: 0.1,
        confidence: 0.95,
        world_surprise: 0,
      }).decision,
    ).toBe("exec");
    expect(
      osSys1Decide(dbPath, {
        action: "deploy",
        risk: 0.3,
        confidence: 0.9,
        world_surprise: 1,
      }).decision,
    ).toBe("escalate_sys2");
    expect(
      osSys1Decide(dbPath, { action: "wipe_disk", risk: 0.99, confidence: 1.0 })
        .decision,
    ).toBe("deny");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
