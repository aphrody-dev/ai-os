// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Aphrody: proxy/virtual-tools.ts without the proxy context (the relay is the MCP proxy of src).
import { Project } from "./project-ext.js";
import type { VirtualToolDefinition } from "./spec/client.js";

/**
 * Create a Project handle bound to a client, via the identity map.
 * Direct `new Project(client, id)` does NOT hydrate projectId.
 */
export function createProject(projectId: string, client: any): Project {
  return client.entities.resolve(Project, ["projectId"], { projectId });
}

export const downloadAssetsTool: VirtualToolDefinition = {
  name: "download_assets",
  description: "Download screens and assets to a local directory",
  source: "sdk",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "Project ID" },
      outputDir: { type: "string", description: "Output directory" },
    },
    required: ["projectId", "outputDir"],
  },
  execute: async (client, args) => {
    const { projectId, outputDir } = args;
    const project = createProject(projectId, client);
    await project.downloadAssets(outputDir);
    return {
      content: [{ type: "text", text: `Assets downloaded to ${outputDir}` }],
    };
  },
};

/** Single registry of SDK-side virtual tools. */
export const virtualTools: VirtualToolDefinition[] = [downloadAssetsTool];
