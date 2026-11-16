import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  callLocalUncensoredModel,
  generateHereticConfigToml,
  LOCALLY_UNCENSORED_CATALOG,
  selectModelsForVram,
} from "../src/lu-provider.ts";
import {
  diffLineStats,
  getCpuThreads,
  isNativeRustLoaded,
  isSafeWorkspacePath,
  snapshotWorkspace,
} from "../src/native-bridge.ts";
import {
  renderOpenTuiFrame,
  SessionStore,
  startOpenCodeServer,
} from "../src/opencode-ui.ts";
import { executePiTool, runPiAgentLoop } from "../src/pi-core.ts";
import {
  parseWorkflowMarkdown,
  runAutonomousNhitlLoop,
  withIsolatedWorktree,
} from "../src/nhitl-loop.ts";

describe("pi-opencode: Rust Native FFI & Torvalds Userspace Guard", () => {
  test("loads pi_opencode_native.dll via bun:ffi and reports logical threads", () => {
    expect(isNativeRustLoaded()).toBe(true);
    expect(getCpuThreads()).toBeGreaterThanOrEqual(4);
  });

  test("blocks C:\\Windows\\System32 and /usr/bin while allowing workspace paths", () => {
    expect(isSafeWorkspacePath("C:\\Windows\\System32\\cmd.exe")).toBe(false);
    expect(isSafeWorkspacePath("C:\\Program Files\\Vendor\\x.exe")).toBe(false);
    expect(
      isSafeWorkspacePath(
        "C:\\aphrody\\packages\\ai-os\\engines\\pi-opencode\\src\\cli.ts",
      ),
    ).toBe(true);
  });

  test("computes exact Rust LCS line diffs and deterministic Merkle workspace digests", () => {
    const stats = diffLineStats("a\nb\nc\n", "a\nb_mod\nc\nd\n");
    expect(stats).toEqual({ added: 2, removed: 1 });

    const dir = mkdtempSync(join(tmpdir(), "pi-oc-snap-"));
    try {
      writeFileSync(join(dir, "x.ts"), "export const v = 42;\n");
      const s1 = snapshotWorkspace(dir);
      const s2 = snapshotWorkspace(dir);
      expect(s1.fileCount).toBe(1);
      expect(s1.merkleHash).toHaveLength(16);
      expect(s1.merkleHash).toBe(s2.merkleHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pi-opencode: Pi Minimalist 4-Tool Agent Core", () => {
  test("executes write -> read -> edit -> bash inside isolated workspace and blocks traversal", async () => {
    const ws = mkdtempSync(join(tmpdir(), "pi-oc-tools-"));
    try {
      const wRes = await executePiTool(
        {
          id: "c1",
          name: "write",
          arguments: {
            path: "math.ts",
            content: "export const add = (a: number, b: number) => a - b;\n",
          },
        },
        { cwd: ws },
      );
      expect(wRes.ok).toBe(true);

      const eRes = await executePiTool(
        {
          id: "c2",
          name: "edit",
          arguments: { path: "math.ts", oldText: "a - b", newText: "a + b" },
        },
        { cwd: ws },
      );
      expect(eRes.ok).toBe(true);
      expect(eRes.diff).toEqual({ added: 1, removed: 1 });

      const rRes = await executePiTool(
        { id: "c3", name: "read", arguments: { path: "math.ts" } },
        { cwd: ws },
      );
      expect(rRes.ok).toBe(true);
      expect(rRes.output).toContain("a + b");

      const escapeRes = await executePiTool(
        {
          id: "c4",
          name: "read",
          arguments: { path: "..\\..\\Windows\\win.ini" },
        },
        { cwd: ws },
      );
      expect(escapeRes.ok).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("pi-opencode: Locally Uncensored + Heretic Provider", () => {
  test("selects open-weights models fitting 12GB RTX 4070 sm_89 VRAM and generates Heretic v2 config", () => {
    const fitting12 = selectModelsForVram(12);
    expect(fitting12.length).toBe(LOCALLY_UNCENSORED_CATALOG.length);
    expect(fitting12.some((m) => m.id === "qwen3.8-27b-uncensored-iq2m")).toBe(
      true,
    );

    const toml = generateHereticConfigToml({
      modelRepo: "Qwen/Qwen3.8-14B",
      mode: "uncensor",
      bnb4bit: true,
    });
    expect(toml).toContain('quantization = "bnb_4bit"');
    expect(toml).toContain('steering_profile = "refusal_suppression"');
  });

  test("round-trips OpenAI-compatible tool calls against a mock Locally Uncensored server", async () => {
    let callIdx = 0;
    const mockLu = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        callIdx++;
        if (callIdx === 1) {
          return Response.json({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "tc_lu_1",
                      function: {
                        name: "write",
                        arguments: JSON.stringify({
                          path: "hello.txt",
                          content: "uncensored-local-ok",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          });
        }
        return Response.json({
          choices: [
            {
              message: { content: "Completed task directly without refusals." },
            },
          ],
        });
      },
    });

    const ws = mkdtempSync(join(tmpdir(), "pi-lu-mock-"));
    try {
      const loopResult = await runPiAgentLoop(
        "Create hello.txt",
        { cwd: ws, allowShell: false },
        (msgs, tools) =>
          callLocalUncensoredModel(
            {
              baseUrl: `http://127.0.0.1:${mockLu.port}/v1`,
              model: "gemma-4-12b-heretic-q4km",
            },
            msgs,
            tools,
          ),
      );
      expect(loopResult.turns).toBe(2);
      expect(readFileSync(join(ws, "hello.txt"), "utf8")).toBe(
        "uncensored-local-ok",
      );
    } finally {
      mockLu.stop(true);
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("pi-opencode: OpenCode UI/Server + Symphony/Ralph Full-Auto NHITL Loop", () => {
  test("serves OpenCode Web UI, health, models, and WAL SQLite sessions + renders OpenTUI", async () => {
    const ws = mkdtempSync(join(tmpdir(), "pi-oc-ui-"));
    const { server, store } = startOpenCodeServer({ port: 0, workspace: ws });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const htmlRes = await fetch(`${base}/ui`);
      expect(htmlRes.status).toBe(200);
      expect(await htmlRes.text()).toContain("Locally Uncensored");

      const createRes = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "NHITL Run 1" }),
      });
      expect(createRes.status).toBe(201);

      const listRes = await fetch(`${base}/api/sessions`);
      const listData = (await listRes.json()) as {
        sessions: Array<{ title: string }>;
      };
      expect(listData.sessions[0].title).toBe("NHITL Run 1");

      const frame = renderOpenTuiFrame({
        workspace: ws,
        activeModel: "qwen3.8-27b-uncensored-iq2m",
        mode: "autonomous-nhitl",
        merkleHash: "0123456789abcdef",
        fileCount: 3,
        sessions: 1,
      });
      expect(frame).toContain("PI-OPENCODE v1.0.0");
    } finally {
      server.stop(true);
      store.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("executes autonomous NHITL loop until empirical bun test gate turns GREEN", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pi-oc-nhitl-"));
    try {
      await withIsolatedWorktree(repo, "task-001", async (isolatedDir) => {
        writeFileSync(
          join(isolatedDir, "calc.test.ts"),
          'import { expect, test } from "bun:test";\nimport { mul } from "./calc.ts";\ntest("mul", () => expect(mul(6, 7)).toBe(42));\n',
        );
        writeFileSync(
          join(isolatedDir, "calc.ts"),
          "export const mul = (a: number, b: number) => a + b;\n",
        );

        const wf = parseWorkflowMarkdown(
          "---\nname: test-nhitl\nmaxIterations: 3\ndefaultAcceptanceCommand: bun test\n---\nFix failing tests.",
        );
        expect(wf.name).toBe("test-nhitl");

        let fixed = false;
        const outcomes = await runAutonomousNhitlLoop({
          workspaceDir: isolatedDir,
          workflow: wf,
          tasks: [
            {
              id: "PRD-1",
              title: "Fix mul() in calc.ts",
              acceptanceCommand: "bun test",
              completed: false,
            },
          ],
          callModel: async () => {
            if (!fixed) {
              fixed = true;
              return {
                content: "Fixing calc.ts",
                toolCalls: [
                  {
                    id: "fix_1",
                    name: "edit",
                    arguments: {
                      path: "calc.ts",
                      oldText: "a + b",
                      newText: "a * b",
                    },
                  },
                ],
              };
            }
            return { content: "Fixed." };
          },
        });

        expect(outcomes).toHaveLength(1);
        expect(outcomes[0].passed).toBe(true);
        expect(outcomes[0].iterationsUsed).toBe(1);
        expect(outcomes[0].beforeSnapshot.merkleHash).not.toBe(
          outcomes[0].afterSnapshot.merkleHash,
        );
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
