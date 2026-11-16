// `@aphrody/ghidra/script`: GhidraScript / FlatProgramAPI globals for translated scripts.
//   import { currentProgram, println, getFunctionAt, toAddr } from "@aphrody/ghidra/script";
// Fields are live bindings updated when a script context is set (runScript/setContext).
import type { JObject } from "./rpc.ts";
import { onContext, getContext } from "./context.ts";

export let currentProgram: JObject | null | undefined;
export let currentAddress: JObject | null | undefined;
export let currentLocation: JObject | null | undefined;
export let currentSelection: JObject | null | undefined;
export let currentHighlight: JObject | null | undefined;
export let monitor: JObject | null | undefined;
export let state: JObject | null | undefined;
export let sourceFile: string | undefined;

function bind(c: ReturnType<typeof getContext>) {
  currentProgram = c?.currentProgram;
  currentAddress = c?.currentAddress;
  currentLocation = c?.currentLocation;
  currentSelection = c?.currentSelection;
  currentHighlight = c?.currentHighlight;
  monitor = c?.monitor;
  state = c?.state;
  sourceFile = c?.sourceFile ?? c?.scriptName;
}
onContext(bind);
bind(getContext());

export * from "./script.generated.ts";
export { getContext, requireContext, setContext, clearContext, type ScriptContext } from "./context.ts";
