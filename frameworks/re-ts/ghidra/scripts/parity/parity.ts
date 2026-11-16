// bun-ghidra side of the parity run. usage: bun parity.ts <workdir> <out.json>
// Must mirror scripts/parity/parity_py.py entry for entry.
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as G from "../../src/index.ts";
import type { JObject } from "../../src/rpc.ts";

const [work, out] = process.argv.slice(2);
if (!work || !out) throw new Error("usage: bun parity.ts <workdir> <out.json>");
const install = process.env.GHIDRA_INSTALL_DIR!;
const R: Record<string, unknown> = {};
const E: Record<string, string> = {};

const S = async (x: any): Promise<string> => (x === null || x === undefined ? "None" : typeof x === "string" ? x : String(await x.toString()));
const N = (x: any) => (typeof x === "bigint" ? Number(x) : x);
const L = async (o: JObject): Promise<any[]> => o.$list();
const pyCmp = (x: any, y: any): number => {
  if (Array.isArray(x) && Array.isArray(y)) { for (let i = 0; i < Math.min(x.length, y.length); i++) { const c = pyCmp(x[i], y[i]); if (c) return c; } return x.length - y.length; }
  return x < y ? -1 : x > y ? 1 : 0;
};
const sorted = <T>(a: T[]) => [...a].sort(pyCmp);
const pySort = (a: string[]) => [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)); // codepoint order like python

async function entry(name: string, fn: () => Promise<unknown> | unknown) {
  try { R[name] = await fn(); } catch (e: any) { R[name] = { error: e?.type ?? e?.name ?? "Error" }; E[name] = String(e?.message ?? e).slice(0, 400); }
}

const snake2camel = (s: string) => s.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());

R["api.started.before"] = G.started();
await G.start(false, { installDir: install });
R["api.start"] = G.started();
const allNames: string[] = JSON.parse(readFileSync(join(work, "all.json"), "utf8"));
R["api.surface"] = allNames.filter((n) => snake2camel(n) in G).sort();

const binpath = join(work, "tiny");
const projloc = join(work, "proj_ts");

{
  await using h = await G.openProgram(binpath, { projectLocation: projloc, projectName: "p", analyze: true });
  const flat = h.flat, program = h.program;
  R["api.open_program"] = { name: await S(await program.getName()), flat: (flat.$c as string).endsWith("FlatProgramAPI") };
  const fm = await program.getFunctionManager();
  const listing = await program.getListing();
  const st = await program.getSymbolTable();
  const rm = await program.getReferenceManager();
  const mem = await program.getMemory();
  const dtm = await program.getDataTypeManager();
  const mon = await G.taskMonitor();
  const fns = await L(await fm.getFunctions(true));
  const names = await Promise.all(fns.map((f) => f.getName()));
  const compute = fns[names.indexOf("compute")]!;
  const add = fns[names.indexOf("add")]!;
  const cEntry = await compute.getEntryPoint();
  const aEntry = await add.getEntryPoint();

  await entry("ops.program.name", async () => S(await program.getName()));
  await entry("ops.program.language", async () => S(await program.getLanguageID()));
  await entry("ops.program.compiler", async () => S(await (await program.getCompilerSpec()).getCompilerSpecID()));
  await entry("ops.program.format", async () => S(await program.getExecutableFormat()));
  await entry("ops.program.imageBase", async () => S(await program.getImageBase()));
  await entry("ops.functions.count", async () => N(await fm.getFunctionCount()));
  await entry("ops.functions.list", async () =>
    sorted(await Promise.all(fns.map(async (f) => [await S(await f.getName()), await S(await f.getEntryPoint()), N(await (await f.getBody()).getNumAddresses())]))));
  await entry("ops.functions.global", async () => Promise.all((await L(await flat.getGlobalFunctions("compute"))).map(async (f) => S(await f.getEntryPoint()))));
  await entry("ops.functions.at", async () => S(await (await flat.getFunctionAt(cEntry)).getName()));
  await entry("ops.functions.containing", async () => S(await (await flat.getFunctionContaining(await cEntry.add(2))).getName()));
  await entry("ops.functions.first_last", async () => [await S(await (await flat.getFirstFunction()).getName()), await S(await (await flat.getLastFunction()).getName())]);
  await entry("ops.function.signature", async () => S(await (await compute.getSignature()).getPrototypeString()));
  await entry("ops.function.callingConvention", async () => S(await compute.getCallingConventionName()));
  await entry("ops.function.params", async () =>
    Promise.all((await L(await compute.getParameters())).map(async (p) => [await S(await p.getName()), await S(await (await p.getDataType()).getName())])));
  await entry("ops.function.callees", async () => pySort(await Promise.all((await L(await compute.getCalledFunctions(mon))).map(async (f) => S(await f.getName())))));
  await entry("ops.function.callers", async () => pySort(await Promise.all((await L(await add.getCallingFunctions(mon))).map(async (f) => S(await f.getName())))));
  await entry("ops.function.stackFrame", async () => N(await (await compute.getStackFrame()).getFrameSize()));
  await entry("ops.listing.instructions", async () =>
    Promise.all((await L(await listing.getInstructions(await compute.getBody(), true))).map(async (i) => [await S(await i.getAddress()), await S(await i.getMnemonicString()), await S(i)])));
  await entry("ops.listing.counts", async () => [N(await listing.getNumCodeUnits()), N(await listing.getNumInstructions()), N(await listing.getNumDefinedData())]);
  await entry("ops.flat.instructions", async () => {
    const a = await flat.getInstructionAt(cEntry);
    return [await S(a), await S(await flat.getInstructionAfter(a)), await S(await flat.getInstructionContaining(await cEntry.add(1)))];
  });
  await entry("ops.symbols.count", async () => N(await st.getNumSymbols()));
  await entry("ops.symbols.names", async () => pySort(await Promise.all((await L(await st.getAllSymbols(true))).map(async (s) => S(await s.getName(true))))));
  await entry("ops.symbols.primary", async () => S(await (await st.getPrimarySymbol(cEntry)).getName()));
  await entry("ops.symbols.flat", async () => Promise.all((await L(await flat.getSymbols("compute", null))).map((s) => S(s))));
  await entry("ops.refs.to", async () =>
    sorted(await Promise.all((await L(await flat.getReferencesTo(aEntry))).map(async (r) => [await S(await r.getFromAddress()), await S(await r.getReferenceType())]))));
  await entry("ops.refs.from", async () =>
    sorted(await Promise.all((await L(await flat.getReferencesFrom(await cEntry.add(4)))).map(async (r) => [await S(await r.getToAddress()), await S(await r.getReferenceType())]))));
  await entry("ops.refs.count", async () => N(await rm.getReferenceSourceCount()));
  await entry("ops.datatypes.root", async () => {
    const c = await dtm.getRootCategory();
    return [await S(await dtm.getName()), await S(await c.getName()), (await L(await c.getCategories())).length];
  });
  await entry("ops.datatypes.count", async () => N(await dtm.getDataTypeCount(true)));
  await entry("ops.memory.blocks", async () =>
    sorted(await Promise.all((await L(await mem.getBlocks())).map(async (b) =>
      [await S(await b.getName()), await S(await b.getStart()), await S(await b.getEnd()), N(await b.getSize()), await b.isRead(), await b.isWrite(), await b.isExecute()]))));
  await entry("ops.memory.bytes", async () => Buffer.from(await flat.getBytes(cEntry, 16)).toString("hex"));
  await entry("ops.memory.int", async () => N(await flat.getInt(cEntry)));
  await entry("ops.memory.contains", async () => [await mem.contains(cEntry), await mem.contains(await flat.toAddr(0x10))]);
  await entry("ops.address.toAddr", async () => [await S(await flat.toAddr(0x401000)), await S(await (await (await flat.getAddressFactory()).getDefaultAddressSpace()).getName())]);
  await entry("ops.find.bytes", async () => S(await flat.findBytes(await program.getMinAddress(), "\\x55\\x48\\x89\\xe5")));
  await entry("ops.find.strings", async () => (await L(await flat.findStrings(null, 4, 1, true, true))).length);
  await entry("ops.namespace.global", async () => S(await (await program.getGlobalNamespace()).getName()));
  await entry("ops.entrypoints", async () => pySort(await Promise.all((await L(await st.getExternalEntryPointIterator())).map((a) => S(a)))));
  await entry("ops.blocks.basic", async () => {
    const m = await jvmNew("ghidra.program.model.block.BasicBlockModel", program);
    return sorted(await Promise.all((await L(await m.getCodeBlocksContaining(await compute.getBody(), mon))).map(async (b) => [await S(await b.getFirstStartAddress()), N(await b.getNumAddresses())])));
  });
  await entry("ops.relocations", async () => N(await (await program.getRelocationTable()).getSize()));
  await entry("ops.decompile.compute", async () => {
    const d = await jvmNew("ghidra.app.decompiler.DecompInterface");
    await d.openProgram(program);
    try {
      const r = await d.decompileFunction(compute, 60, mon);
      const df = await r.getDecompiledFunction();
      return df === null ? null : String(await df.getC());
    } finally {
      await d.dispose();
    }
  });
  await entry("ops.decompile.all", async () => {
    const d = await jvmNew("ghidra.app.decompiler.DecompInterface");
    await d.openProgram(program);
    try {
      let n = 0;
      for (const f of fns) if (await (await d.decompileFunction(f, 60, mon)).decompileCompleted()) n++;
      return n;
    } finally {
      await d.dispose();
    }
  });
  await entry("ops.pcode.high", async () => {
    const d = await jvmNew("ghidra.app.decompiler.DecompInterface");
    await d.openProgram(program);
    try {
      const hf = await (await d.decompileFunction(compute, 60, mon)).getHighFunction();
      if (hf === null) return null;
      return await Promise.all((await L(await hf.getPcodeOps())).map(async (o) => S(await o.getMnemonic())));
    } finally {
      await d.dispose();
    }
  });
  await entry("ops.pcode.raw", async () => {
    const i = await flat.getInstructionAt(cEntry);
    return Promise.all((await L(await i.getPcode())).map(async (o) => S(await o.getMnemonic())));
  });
  await entry("ops.mutate.comment_label_bookmark", async () => {
    const a = await cEntry.add(4);
    await G.transaction(program, "mutate", async () => {
      await flat.setEOLComment(a, "parity-comment");
      await flat.createLabel(a, "parity_label", true);
      await flat.createBookmark(a, "Parity", "note");
    });
    return [await S(await flat.getEOLComment(a)), await Promise.all((await L(await flat.getSymbols("parity_label", null))).map(async (s) => S(await s.getName()))), (await L(await flat.getBookmarks(a))).length];
  });
  await entry("ops.mutate.rollback", async () => {
    const a = await cEntry.add(8);
    try {
      await G.transaction(program, "bad", async () => {
        await flat.setEOLComment(a, "rolled-back");
        throw new RangeError("x");
      });
    } catch (e) { if (!(e instanceof RangeError)) throw e; }
    return (await flat.getEOLComment(a)) === null;
  });
  await entry("api.transaction.id", async () => G.transaction(program, "t", (id) => Number(id) > 0));
  await entry("api.analysis_properties", async () => pySort((await L(await (await G.analysisProperties(program)).getOptionNames())).map(String)).slice(0, 60));
  await entry("api.program_info", async () => pySort((await L(await (await G.programInfo(program)).getOptionNames())).map(String)));
  await entry("api.analyze.log_nonempty", async () => typeof (await G.analyze(program)) === "string");
}

async function jvmNew(cls: string, ...a: unknown[]) { return G.jvm().newObject(cls, ...a); }

R["api.program_loader"] = (await G.programLoader()).$c;
R["api.task_monitor.default"] = (await G.taskMonitor()).$c;
R["api.task_monitor.timeout"] = (await G.taskMonitor(5)).$c;

const project = await G.openProject(join(projloc, "p"), "p");
R["api.open_project"] = await S(await project.getName());

await entry("api.open_project.missing", async () => {
  try { await G.openProject(join(projloc, "p"), "does_not_exist"); } catch (e: any) { if (e.name === "FileNotFoundError") return "FileNotFoundError"; throw e; }
});
await entry("api.open_project.create", async () => {
  mkdirSync(join(work, "proj_new_ts"), { recursive: true });
  const p = await G.openProject(join(work, "proj_new_ts"), "n", true);
  const n = await S(await p.getName());
  await p.close();
  return n;
});
await entry("api.program_context", async () => G.programContext(project, "/tiny", async (p) => S(await p.getName())));
await entry("api.consume_program", async () => {
  const [p, c] = await G.consumeProgram(project, "/tiny");
  const n = await S(await p.getName());
  await p.release(c);
  return n;
});
await entry("api.consume_program.missing", async () => {
  try { await G.consumeProgram(project, "/nope"); } catch (e: any) { if (e.name === "FileNotFoundError") return "FileNotFoundError"; throw e; }
});
await entry("api.walk_project", async () => {
  const names: string[] = [];
  await G.walkProject(project, async (f) => { names.push(await S(await f.getPathname())); });
  return pySort(names);
});
await entry("api.walk_programs", async () => {
  const names: string[] = [];
  await G.walkPrograms(project, async (_f, p) => { names.push(await S(await p.getName())); });
  return pySort(names);
});
await entry("api.open_filesystem", async () => {
  const fs = await G.openFilesystem(join(work, "tiny.zip"));
  try {
    return [await S(await fs.getType()), N(await fs.getFileCount())];
  } finally {
    await fs.close();
  }
});
await entry("api.open_filesystem.unsupported", async () => {
  try { await G.openFilesystem(join(work, "plain.txt")); return "opened"; } catch { return "ValueError"; }
});
await entry("api.ghidra_script", async () => {
  const [o, e] = await G.ghidraScript(join(work, "Hello.java"), project, null, ["a", "b"], false, false);
  return [o.trim(), e.trim()];
});
await entry("api.ApplicationInfo", async () => {
  const a = G.ApplicationInfo.fromFile(join(install, "Ghidra", "application.properties"));
  return [a.name, a.version, a.release_name, a.java_min, a.build_date_short, a.layout_version];
});
await entry("api.ExtensionDetails", async () => {
  const e = G.ExtensionDetails.fromFile(join(work, "extension.properties"));
  return [e.name, e.description, e.author, e.version, e.plugin_version];
});
await entry("api.debug_callback", async () => G.debugCallback((x: number) => x + 1)(1));
await entry("api.get_current_interpreter", async () => G.getCurrentInterpreter() !== undefined);
await entry("api.launchers", async () => [
  typeof G.HeadlessPyGhidraLauncher === "function", G.DeferredPyGhidraLauncher.name, G.GuiPyGhidraLauncher.name, G.HeadlessPyGhidraLauncher.name,
]);
await entry("api.ProgramTypeError", async () => new G.ProgramTypeError("x") instanceof TypeError);
await entry("api.open_program.loader_invalid", async () => {
  try {
    await using _h = await G.openProgram(join(work, "tiny"), { projectLocation: join(work, "proj_l_ts"), analyze: false, loader: "java.lang.String" });
    return "opened";
  } catch (e: any) { return e?.type === "java.lang.IllegalArgumentException" || /Loader|assign/.test(String(e)) ? "TypeError" : "other:" + String(e).slice(0, 80); }
});
await entry("api.open_program.language_invalid", async () => {
  try {
    await using _h = await G.openProgram(join(work, "tiny"), { projectLocation: join(work, "proj_l2_ts"), analyze: false, language: "bogus:LE:64:default" });
    return "opened";
  } catch (e: any) { return /Invalid Language/.test(String(e)) ? "ValueError" : "other:" + String(e).slice(0, 80); }
});

await project.close();

await entry("api.run_script", async () => {
  const lines: string[] = [];
  const w = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: any) => { lines.push(String(s)); return true; };
  try {
    await G.runScript(join(work, "tiny"), join(work, "run_script.ts"), { projectLocation: projloc, projectName: "p", analyze: false });
  } finally { (process.stdout as any).write = w; }
  return lines.join("").trim();
});

writeFileSync(out + ".err", JSON.stringify(E, null, 1));
writeFileSync(out, JSON.stringify(R, null, 1));
console.log("entries", Object.keys(R).length);
await G.stop();
process.exit(0);
