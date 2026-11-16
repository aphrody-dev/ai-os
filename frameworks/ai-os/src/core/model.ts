// Model and embedder resolution for the agent: thin layer over the single model bridge (../llm), nothing hardcoded.
// AGENT_MODEL=provider/model (any id from llm_models), else the first discovered model. AGENT_EMBEDDER=hash|provider/model.
import { providerEmbedder } from "../llm/model";
import type { Embedder } from "../llm/types";
import { hashEmbedder } from "./context";

export { resolveModel } from "../llm/model";

export function resolveEmbedder(
  spec = Bun.env.AGENT_EMBEDDER ?? "hash",
): Embedder {
  return spec === "hash" ? hashEmbedder() : providerEmbedder(spec);
}
