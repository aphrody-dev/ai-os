import { describe, expect, test } from "bun:test";
import { createWebGpuOsDescriptor, resolveGatekeeperForUrl } from "../../src/webgpu-os/index.ts";

describe("Full WebGPU OS fusion (ai-os + cloudflare-os + nysh)", () => {
  test("exposes kernel, cloudflare-os edge platform, nysh shell, and WebGPU backends", () => {
    const desc = createWebGpuOsDescriptor();
    expect(desc.kernel).toBe("ai-os");
    expect(desc.edgePlatform).toBe("cloudflare-os");
    expect(desc.shell).toBe("nysh");
    expect(desc.gpuBackends).toContain("webgpu");
    expect(desc.gatekeepers.length).toBeGreaterThanOrEqual(9);
  });

  test("routes outbound API URLs to their isolated Cloudflare-OS Gatekeeper worker", () => {
    expect(resolveGatekeeperForUrl("https://api.github.com/repos/aphrody-labs/cloudflare-os")?.workerPackage).toBe(
      "gatekeeper-github",
    );
    expect(resolveGatekeeperForUrl("https://generativelanguage.googleapis.com/v1beta/models")?.workerPackage).toBe(
      "gatekeeper-gemini",
    );
    expect(resolveGatekeeperForUrl("https://example.org")).toBeUndefined();
  });
});
