// SPDX-License-Identifier: Apache-2.0
// Unified WebGPU OS bridge inside `ai-os` fusing:
// - `ai-os` ring-3 agent kernel & MCP/A2A router,
// - `aphrody-labs/cloudflare-os` (Bun-migrated Durable-Object Workshop, Gadgets, and 21 Gatekeepers),
// - `nysh` (`nsh` TSX/GPUI Native Shell + `aysh` `niubash`/`rubash`/`rio-vt` GPU terminal).

export interface CloudflareOsGatekeeperSpec {
  readonly id: string;
  readonly workerPackage: string;
  readonly capabilityTokenHeader: string;
  readonly outboundHost: string;
}

export const GATEKEEPER_REGISTRY: readonly CloudflareOsGatekeeperSpec[] = [
  { id: "anthropic", workerPackage: "gatekeeper-anthropic", capabilityTokenHeader: "x-cf-os-cap", outboundHost: "api.anthropic.com" },
  { id: "cloudflare", workerPackage: "gatekeeper-cloudflare", capabilityTokenHeader: "x-cf-os-cap", outboundHost: "api.cloudflare.com" },
  { id: "discord", workerPackage: "gatekeeper-discord", capabilityTokenHeader: "x-cf-os-cap", outboundHost: "discord.com" },
  { id: "gemini", workerPackage: "gatekeeper-gemini", capabilityTokenHeader: "x-cf-os-cap", outboundHost: "generativelanguage.googleapis.com" },
  { id: "github", workerPackage: "gatekeeper-github", capabilityTokenHeader: "x-cf-os-cap", outboundHost: "api.github.com" },
  { id: "linear", workerPackage: "gatekeeper-linear", capabilityTokenHeader: "x-cf-os-cap", outboundHost: "api.linear.app" },
  { id: "notion", workerPackage: "gatekeeper-notion", capabilityTokenHeader: "x-cf-os-cap", outboundHost: "api.notion.com" },
  { id: "openai", workerPackage: "gatekeeper-openai", capabilityTokenHeader: "x-cf-os-cap", outboundHost: "api.openai.com" },
  { id: "slack", workerPackage: "gatekeeper-slack", capabilityTokenHeader: "x-cf-os-cap", outboundHost: "slack.com" },
] as const;

export interface WebGpuOsDescriptor {
  readonly kernel: "ai-os";
  readonly edgePlatform: "cloudflare-os";
  readonly shell: "nysh";
  readonly gpuBackends: readonly ["webgpu", "vulkan", "d3d12", "metal"];
  readonly gatekeepers: readonly CloudflareOsGatekeeperSpec[];
}

export function createWebGpuOsDescriptor(): WebGpuOsDescriptor {
  return {
    kernel: "ai-os",
    edgePlatform: "cloudflare-os",
    shell: "nysh",
    gpuBackends: ["webgpu", "vulkan", "d3d12", "metal"],
    gatekeepers: GATEKEEPER_REGISTRY,
  };
}

export function resolveGatekeeperForUrl(rawUrl: string): CloudflareOsGatekeeperSpec | undefined {
  const host = new URL(rawUrl).hostname.toLowerCase();
  return GATEKEEPER_REGISTRY.find((gk) => host === gk.outboundHost || host.endsWith(`.${gk.outboundHost}`));
}
