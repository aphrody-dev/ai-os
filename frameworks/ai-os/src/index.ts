// @aphrody/ai-os: the single AI unit of src. Sub-modules are also exported separately
// (./core, ./llm, ./gateway, ./research, ./relay).
export * from "./core/index";
export * as llm from "./llm/index";
export {
  applyPatch,
  createGateway,
  createUIMessageStreamResponse,
  diffToPatches,
  type Channel,
  type GatewayOptions,
  type Inbound,
  type JsonPatch,
  type UIElement,
  type UISpec,
  validateUISpec,
  webhookChannel,
} from "./gateway/index";
