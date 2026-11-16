import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../core/memory";
import { memorySync } from "./memory-sync";

test("push claude files, pull gemini entries once, append-only", async () => {
  const home = mkdtempSync(join(tmpdir(), "ms-home-"));
  const mem = mkdtempSync(join(tmpdir(), "ms-mem-"));
  writeFileSync(join(mem, "a.md"), "---\nname: a\n---\nfact a");
  writeFileSync(join(mem, "MEMORY.md"), "- [A](a.md) — a\n");
  const m = new Memory(join(home, "memory.sqlite"));
  await m.add("gemini fact one", "gemini");
  await m.add("not exported", "user");
  m.close();
  const r1 = await memorySync({ home, memDir: mem });
  expect(r1).toEqual({ pushed: 2, pulled: 1 });
  const r2 = await memorySync({ home, memDir: mem }); // MEMORY.md changed (pointer line) and the inbox is new
  expect(r2.pulled).toBe(0);
  expect(await memorySync({ home, memDir: mem })).toEqual({
    pushed: 0,
    pulled: 0,
  });
  const inbox = readFileSync(join(mem, "gemini-inbox.md"), "utf8");
  expect(inbox).toContain("[source=gemini");
  expect(inbox).toContain("gemini fact one");
  expect(inbox).not.toContain("not exported");
  expect(readFileSync(join(mem, "MEMORY.md"), "utf8")).toContain(
    "(gemini-inbox.md)",
  );
});
