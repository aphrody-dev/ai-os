import { expect, test } from "bun:test";
import { scriptedModel } from "../../src/llm/testing";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../../src/core/memory";
import {
  type Fields,
  fileName,
  loadYaml,
  research,
  validate,
  validateDir,
} from "../../src/research/index";

const REF = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "ai_foundations_to_agi",
);

test.skipIf(!existsSync(REF))(
  "validator port agrees with validate_json.py on the reference pack",
  async () => {
    const r = await validateDir(join(REF, "outline.yaml"));
    expect(r.length).toBe(3);
    expect(r.every((x) => x.ok)).toBe(true);
  },
);

test("validate: uncertain mismatch and missing fields", () => {
  const fields: Fields = {
    required_fields: [
      { name: "a", type: "string" },
      { name: "b", type: "list[string]" },
    ],
  };
  expect(validate(fields, { a: "x", b: ["y"], uncertain: [] }).ok).toBe(true);
  expect(
    validate(fields, { a: "x [uncertain]", b: ["y"], uncertain: [] }).errors[0],
  ).toContain("mismatch");
  expect(validate(fields, { a: "", b: [], uncertain: [] }).errors[0]).toContain(
    "missing fields: a, b",
  );
  expect(fileName("Intelligence artificielle générale")).toBe(
    "Intelligence_artificielle_generale",
  );
});

test.skipIf(!existsSync(REF))(
  "research: fan-out, results written, validated, fed to memory",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-research-"));
    cpSync(join(REF, "outline.yaml"), join(dir, "outline.yaml"));
    cpSync(join(REF, "fields.yaml"), join(dir, "fields.yaml"));
    const fields = await loadYaml<Fields>(join(dir, "fields.yaml"));
    const answer = Object.fromEntries(
      fields.required_fields.map((f) => [
        f.name,
        f.type.startsWith("list") ? ["v"] : "v",
      ]),
    );
    const model = scriptedModel(JSON.stringify({ ...answer, uncertain: [] }));
    const home = join(dir, "home");
    const r = await research({
      outlinePath: join(dir, "outline.yaml"),
      model,
      home,
      web: false,
    });
    expect(r.passed).toBe(3);
    expect(existsSync(join(dir, "results", "Alan_Turing.json"))).toBe(true);
    const m = new Memory(join(home, "memory.sqlite"));
    const hits = await m.ctx.select("Alan Turing era", {
      sources: ["research"],
      k: 3,
    });
    expect(hits[0]?.id).toStartWith(
      "research:ai_foundations_to_agi/Alan_Turing#",
    );
    m.close();
  },
);
