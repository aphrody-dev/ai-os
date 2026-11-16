import { describe, expect, test } from "bun:test";
import { validate } from "../../src/llm/schema";
import { CORE_TOOLS } from "../../src/relay/core-tools.ts";
import { TOOLS, toolByName } from "../../src/relay/tools.ts";

describe("ai-os relay CORE_TOOLS (@aphrody/core integration)", () => {
  test("all CORE_TOOLS are registered on TOOLS and toolByName", () => {
    expect(CORE_TOOLS.length).toBeGreaterThanOrEqual(13);
    for (const tool of CORE_TOOLS) {
      expect(TOOLS.some((t) => t.name === tool.name)).toBe(true);
      expect(toolByName.get(tool.name)).toBe(tool);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  test("schemas validate nominal arguments for RE, Ghidra, parsing, and migration", () => {
    const ghidra = toolByName.get("core_ghidra_decompile")!;
    expect(
      validate(ghidra.inputSchema, { path: "app.exe", maxFunctions: 32 }),
    ).toEqual([]);

    const parseTool = toolByName.get("core_parse")!;
    expect(
      validate(parseTool.inputSchema, {
        path: "a.ts",
        content: "export const x = 1;",
      }),
    ).toEqual([]);

    const migrateTool = toolByName.get("core_migrate_transform")!;
    expect(
      validate(migrateTool.inputSchema, {
        langOrPath: "ts",
        source: "import 'fs';",
      }),
    ).toEqual([]);
  });
});
