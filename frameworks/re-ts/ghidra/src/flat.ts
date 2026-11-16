// FlatAPI export list for scripts translated from GhidraScript / pyghidra (target of system/py2bun-ts).
// Source: Ghidra 12.2 ghidra.program.flatapi.FlatProgramAPI and ghidra.app.script.GhidraScript
// (public/protected methods, extracted from the fork clone on fr1: /srv/ghidra).
// Every method is async (Promise) because the JVM lives in another process; a script is `await`-ed code.

/** ghidra.program.flatapi.FlatProgramAPI public methods. */
export const FLAT_PROGRAM_API = [
  "addEntryPoint", "addInstructionXref", "analyze", "analyzeAll", "analyzeChanges", "clearListing",
  "createAddressSet", "createAsciiString", "createBookmark", "createByte", "createChar", "createClass",
  "createData", "createDouble", "createDWord", "createDwords", "createEquate", "createExternalReference",
  "createFloat", "createFragment", "createFunction", "createLabel", "createMemoryBlock",
  "createMemoryReference", "createNamespace", "createQWord", "createStackReference", "createSymbol",
  "createUnicodeString", "createWord", "disassemble", "end", "find", "findBytes", "findPascalStrings",
  "findStrings", "getAddressFactory", "getBookmarks", "getByte", "getBytes", "getCurrentProgram",
  "getDataAfter", "getDataAt", "getDataBefore", "getDataContaining", "getDataTypes", "getDouble",
  "getEOLComment", "getEquate", "getEquates", "getFirstData", "getFirstFunction", "getFirstInstruction",
  "getFloat", "getFragment", "getFunction", "getFunctionAfter", "getFunctionAt", "getFunctionBefore",
  "getFunctionContaining", "getGlobalFunctions", "getInstructionAfter", "getInstructionAt",
  "getInstructionBefore", "getInstructionContaining", "getInt", "getLastData", "getLastFunction",
  "getLastInstruction", "getLong", "getMemoryBlock", "getMemoryBlocks", "getMonitor", "getNamespace",
  "getPlateComment", "getPostComment", "getPreComment", "getProgramFile", "getProjectRootFolder",
  "getReference", "getReferencesFrom", "getReferencesTo", "getRepeatableComment", "getShort", "getSymbol",
  "getSymbolAfter", "getSymbolAt", "getSymbolBefore", "getSymbols", "getUndefinedDataAfter",
  "getUndefinedDataAt", "getUndefinedDataBefore", "openDataTypeArchive", "openFileDataTypeArchive",
  "removeBookmark", "removeData", "removeDataAt", "removeEntryPoint", "removeEquate", "removeEquates",
  "removeFunction", "removeFunctionAt", "removeInstruction", "removeInstructionAt", "removeMemoryBlock",
  "removeReference", "removeSymbol", "saveProgram", "set", "setByte", "setBytes", "setDouble",
  "setEOLComment", "setFloat", "setInt", "setLong", "setPlateComment", "setPostComment", "setPreComment",
  "setReferencePrimary", "setRepeatableComment", "setShort", "start", "toAddr",
] as const;

/** ghidra.app.script.GhidraScript additional methods (not in FlatProgramAPI). */
export const GHIDRA_SCRIPT_EXTRA = [
  "askAddress", "askBytes", "askChoice", "askChoices", "askDirectory", "askDomainFile", "askDouble",
  "askFile", "askInt", "askLanguage", "askLong", "askPassword", "askProgram", "askProjectFolder",
  "askString", "askValues", "askYesNo", "clearBackgroundColor", "createHighlight", "createProgram",
  "createSelection", "getAnalysisOptionDefaultValue", "getAnalysisOptionDefaultValues",
  "getAnalysisOptionDescription", "getAnalysisOptionDescriptions", "getCategory", "getCodeUnitFormat",
  "getCurrentAnalysisOptionsAndValues", "getDefaultLanguage", "getDemangled", "getEOLCommentAsRendered",
  "getGhidraVersion", "getLanguage", "getPlateCommentAsRendered", "getPostCommentAsRendered",
  "getPreCommentAsRendered", "getRepeatableCommentAsRendered", "getReusePreviousChoices",
  "getScriptAnalysisMode", "getScriptArgs", "getScriptName", "getSourceFile", "getState", "getUserName",
  "goTo", "importFile", "importFileAsBinary", "isAnalysisOptionDefaultValue", "isRunningHeadless", "popup",
  "print", "printerr", "printf", "println", "removeHighlight", "removeSelection", "run", "runCommand",
  "runScript", "runScriptPreserveMyState", "setAnalysisOption", "setAnalysisOptions", "setBackgroundColor",
  "setCurrentHighlight", "setCurrentLocation", "setCurrentSelection", "setReusePreviousChoices",
  "setScriptArgs", "setToolStatusMessage",
] as const;

/** Script-level fields (GhidraScript protected fields / pyghidra script globals). */
export const SCRIPT_FIELDS = [
  "currentProgram", "currentAddress", "currentLocation", "currentSelection", "currentHighlight",
  "monitor", "state", "sourceFile",
] as const;

export type FlatMethodName = (typeof FLAT_PROGRAM_API)[number] | (typeof GHIDRA_SCRIPT_EXTRA)[number];

/** Console-side methods implemented in TypeScript (no JVM round trip). */
export const LOCAL_METHODS = new Set<string>([
  "print", "println", "printerr", "printf", "popup", "isRunningHeadless", "getScriptName", "getScriptArgs",
  "setScriptArgs", "askAddress", "askBytes", "askChoice", "askChoices", "askDirectory", "askDomainFile",
  "askDouble", "askFile", "askInt", "askLanguage", "askLong", "askPassword", "askProgram",
  "askProjectFolder", "askString", "askValues", "askYesNo", "setToolStatusMessage",
]);

export type Flat = { readonly [K in FlatMethodName]: (...args: any[]) => Promise<any> } & {
  readonly [k: string]: any;
};

/** Cancelled ask*() in a headless context without a preset answer (mirrors CancelledException). */
export class CancelledError extends Error {
  constructor(what: string) {
    super(`Cancelled: ${what} (no preset answer; set GHIDRA_ASK_<NAME>)`);
    this.name = "CancelledException";
  }
}

export interface FlatBackend {
  /** Invoke `method` on the Java FlatProgramAPI/GhidraScript-like object. */
  callFlat(method: string, args: unknown[]): Promise<unknown>;
}

const FLAT_RESERVED = new Set(["then", "toJSON", "valueOf", "toString", "constructor", "inspect"]);

/** Build the `Flat` proxy: local methods run here, everything else goes to the backend. */
export function createFlat(
  backend: FlatBackend,
  opts: { scriptArgs?: string[]; scriptName?: string; out?: (s: string) => void; err?: (s: string) => void } = {},
): Flat {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  let scriptArgs = opts.scriptArgs ?? [];
  const ask = async (name: string, fallback?: unknown) => {
    const env = process.env[`GHIDRA_ASK_${name.toUpperCase()}`];
    if (env !== undefined) return env;
    if (fallback !== undefined) return fallback;
    throw new CancelledError(name);
  };
  const local: Record<string, (...a: any[]) => any> = {
    print: async (s: unknown) => void out(String(s)),
    println: async (s: unknown = "") => void out(String(s) + "\n"),
    printerr: async (s: unknown) => void err(String(s) + "\n"),
    printf: async (fmt: string, ...a: unknown[]) => void out(sprintf(fmt, a)),
    popup: async (s: unknown) => void err(String(s) + "\n"),
    isRunningHeadless: async () => true,
    getScriptName: async () => opts.scriptName ?? "script",
    getScriptArgs: async () => scriptArgs,
    setScriptArgs: async (a: string[]) => void (scriptArgs = a),
    setToolStatusMessage: async () => undefined,
    askYesNo: async (_t: string, _m: string) => {
      const v = String(await ask("yesno", true));
      if (v === "cancel") throw new CancelledError("YesNo");
      return v === "true";
    },
  };
  for (const n of ["askAddress", "askBytes", "askChoice", "askChoices", "askDirectory", "askDomainFile",
    "askDouble", "askFile", "askInt", "askLanguage", "askLong", "askPassword", "askProgram", "askProjectFolder",
    "askString", "askValues"]) {
    local[n] = async () => {
      const v = await ask(n.slice(3));
      if (typeof v !== "string") return v;
      if (n === "askInt" || n === "askDouble") return Number(v);
      if (n === "askLong") return BigInt(v) >= -(2n ** 53n) && BigInt(v) <= 2n ** 53n ? Number(v) : BigInt(v);
      return v;
    };
  }
  return new Proxy({} as Flat, {
    get(_t, prop) {
      if (typeof prop !== "string" || FLAT_RESERVED.has(prop)) return undefined;
      if (LOCAL_METHODS.has(prop) && local[prop]) return local[prop];
      return (...args: unknown[]) => backend.callFlat(prop, args);
    },
  });
}

/** Minimal Java-style printf (%s %d %x %X %o %c %b %e %f %n %%, flags - 0 +, precision on %s %f %e) for GhidraScript.printf. */
export function sprintf(fmt: string, args: unknown[]): string {
  let i = 0;
  return fmt.replace(/%([-0+]*)(\d*)(?:\.(\d+))?([sSdxXofeEcbBn%])/g, (_m, fl: string, w: string, p: string | undefined, c: string) => {
    if (c === "%") return "%";
    if (c === "n") return "\n";
    const a = args[i++];
    let s: string;
    const bits = (v: unknown, radix: number) => {
      const b = typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v)));
      // Java prints negative values as two's complement: int width when it fits, else long
      return b < 0n ? BigInt.asUintN(b >= -(2n ** 31n) ? 32 : 64, b).toString(radix) : b.toString(radix);
    };
    if (c === "d") s = typeof a === "bigint" ? a.toString() : String(Math.trunc(Number(a)));
    else if (c === "x") s = bits(a, 16);
    else if (c === "X") s = bits(a, 16).toUpperCase();
    else if (c === "o") s = bits(a, 8);
    else if (c === "f") s = Number(a).toFixed(p === undefined ? 6 : Number(p));
    else if (c === "e" || c === "E") {
      s = Number(a).toExponential(p === undefined ? 6 : Number(p)).replace(/e([+-])(\d)$/, "e$10$2");
      if (c === "E") s = s.toUpperCase();
    } else if (c === "c") s = typeof a === "number" ? String.fromCodePoint(a) : String(a).slice(0, 1);
    else if (c === "b" || c === "B") s = String(a !== null && a !== undefined && a !== false);
    else {
      s = String(a);
      if (p !== undefined) s = s.slice(0, Number(p));
    }
    if (c === "S" || c === "B") s = s.toUpperCase();
    const numeric = "dfxXoeE".includes(c);
    if (fl.includes("+") && numeric && !s.startsWith("-")) s = "+" + s;
    const width = Number(w || 0);
    if (fl.includes("-")) return s.padEnd(width);
    if (fl.includes("0") && numeric) {
      const sign = /^[-+]/.test(s) ? s[0] : "";
      return sign + s.slice(sign.length).padStart(width - sign.length, "0");
    }
    return s.padStart(width);
  });
}
