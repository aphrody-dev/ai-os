import { describe, expect, it } from "bun:test";
import {
  executeRosegriffonOps,
  inspectRosegriffonStatus,
} from "../src/nexus/rosegriffon.ts";
import { executeUnifiedDomainTool } from "../src/nexus/unified-mcp.ts";
import { executeMcpTool, MCP_TOOLS } from "../src/protocols/mcp.ts";

describe("Native Rosegriffon Ops Integration in ai-os", () => {
  it("exposes rosegriffon_ops and n2b_rea in MCP tool catalog", () => {
    const roseTool = MCP_TOOLS.find((t) => t.name === "rosegriffon_ops");
    expect(roseTool).toBeDefined();
    expect(roseTool?.inputSchema).toBeDefined();

    const reaTool = MCP_TOOLS.find((t) => t.name === "n2b_rea");
    expect(reaTool).toBeDefined();
    const ops = (reaTool?.inputSchema as any)?.properties?.op?.enum as string[];
    expect(ops).toContain("level5_formats");
    expect(ops).toContain("level5_decode");
    expect(ops).toContain("pdata_sre");
    expect(ops).toContain("rtti_dump");
  });

  it("inspects rosegriffon status successfully", async () => {
    const status = await inspectRosegriffonStatus();
    expect(status.ok).toBe(true);
    expect(status.tools).toBeDefined();
    expect((status.tools as any).nie.installed).toBe(true);
    expect((status.tools as any).ie.installed).toBe(true);
    expect(status.packages).toBeDefined();
  });

  it("executes rosegriffon_ops status via executeUnifiedDomainTool", async () => {
    const res = await executeUnifiedDomainTool("rosegriffon_ops", {
      action: "status",
    });
    expect(res.handled).toBe(true);
    expect((res.payload as any)?.ok).toBe(true);
    expect((res.payload as any)?.tools?.nie?.version).toContain("1.4.8");
  });

  it("executes rosegriffon_ops wasm_verify", async () => {
    const res = await executeRosegriffonOps("wasm_verify");
    expect(res.ok).toBe(true);
    expect(res.crate).toBe("aphrody-nie-wasm");
    expect(res.hasCargoToml).toBe(true);
    expect(res.hasLibRs).toBe(true);
  });

  it("executes rosegriffon_ops deploy_check", async () => {
    const res = await executeRosegriffonOps("deploy_check");
    expect(res.ok).toBe(true);
    expect(res.hasNextConfig).toBe(true);
    expect(res.hasPackageJson).toBe(true);
  });

  it("executes rosegriffon_ops via executeMcpTool protocol dispatcher", async () => {
    const res = await executeMcpTool("rosegriffon_ops", {
      action: "status",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].type).toBe("text");
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.tools.nie.path).toContain("nie.exe");
  });

  it("executes n2b_rea level5_formats via executeMcpTool", async () => {
    const res = await executeMcpTool("n2b_rea", {
      op: "level5_formats",
      path: "C:/src/apps/rosegriffon/crates/aphrody-nie-formats",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].type).toBe("text");
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.engine).toBe("nie.exe");
  });
});
