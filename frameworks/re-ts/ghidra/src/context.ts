// Current script context (pyghidra/GhidraScript globals). Set by runScript(), the plugin or user code.
import type { Session, JObject } from "./rpc.ts";
import type { Flat } from "./flat.ts";

export interface ScriptContext {
  session: Session;
  project?: JObject | null;
  currentProgram?: JObject | null;
  currentAddress?: JObject | null;
  currentLocation?: JObject | null;
  currentSelection?: JObject | null;
  currentHighlight?: JObject | null;
  monitor?: JObject | null;
  state?: JObject | null;
  /** FlatProgramAPI-like facade (println/ask* local, rest forwarded to the JVM) */
  flat: Flat;
  /** the raw Java FlatProgramAPI object */
  javaFlat?: JObject;
  scriptArgs?: string[];
  scriptName?: string;
  /** path of the running script (GhidraScript.getSourceFile); defaults to scriptName */
  sourceFile?: string;
}

/** nested runScript()/setContext() calls form a stack: clearContext() restores the parent context */
const stack: ScriptContext[] = [];
const listeners = new Set<(c: ScriptContext | undefined) => void>();

export function setContext(c: ScriptContext) { stack.push(c); for (const l of listeners) l(c); }
export function clearContext() { stack.pop(); const top = stack[stack.length - 1]; for (const l of listeners) l(top); }
export function getContext(): ScriptContext | undefined { return stack[stack.length - 1]; }
export function requireContext(): ScriptContext {
  const ctx = getContext();
  if (!ctx) throw new Error("no Ghidra script context: use runScript() or setContext() first");
  return ctx;
}
export function onContext(l: (c: ScriptContext | undefined) => void) { listeners.add(l); return () => listeners.delete(l); }
