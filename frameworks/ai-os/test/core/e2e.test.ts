// End-to-end: one tool-using task, memory persisted across runs, skill created. Deterministic scripted model.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, scriptedModel } from "../../src/llm/testing";
import { Memory, run, Skills } from "../../src/core/index";

test("agent run: tools, memory, skill", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "agent-ws-"));
  const model = scriptedModel(
    {
      toolCalls: [
        call("1", "write_file", {
          path: "hello.txt",
          content: "hi from agent",
        }),
      ],
    },
    {
      toolCalls: [
        call("2", "memory_add", {
          content: "user prefers greetings in hello.txt",
        }),
        call("3", "skill_create", {
          name: "Write greeting",
          description: "Write a greeting file",
          body: "1. write_file hello.txt",
        }),
      ],
    },
    "done",
  );
  const r = await run({ task: "write a greeting", model, home, cwd });
  expect(r.text).toBe("done");
  expect(r.toolCalls).toEqual(["write_file", "memory_add", "skill_create"]);
  expect(await Bun.file(join(cwd, "hello.txt")).text()).toBe("hi from agent");

  const mem = new Memory(join(home, "memory.sqlite"));
  expect(await mem.search("greetings")).toContain(
    "user prefers greetings in hello.txt",
  );
  mem.close();
  const skills = await new Skills(join(home, "skills")).list();
  expect(skills.map((s) => s.name)).toEqual(["write-greeting"]);

  // second run: memory and skill are recalled into the system prompt
  const model2 = scriptedModel("ok");
  await run({ task: "greeting again", model: model2, home, cwd });
  const sys = model2.calls[0]?.system ?? "";
  expect(sys).toContain("write-greeting");
  expect(sys).toContain("user prefers greetings");
});
