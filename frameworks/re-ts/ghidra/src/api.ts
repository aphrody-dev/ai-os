// pyghidra public API (pyghidra 3.x `__all__`) for Bun, over the reflection bridge.
// Every function is async: the JVM runs in a child process. Python context managers map to
// callbacks (`withX(..., fn)`) and `await using` (Symbol.asyncDispose).
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Session, type JObject, type StartOptions } from "./rpc.ts";
import { createFlat, type Flat } from "./flat.ts";
import { setContext, clearContext, getContext, type ScriptContext } from "./context.ts";

export const __version__ = "3.2.0"; // pyghidra release this surface was matched against (pypi 3.2.0, Ghidra 12.2)
export const MINIMUM_GHIDRA_VERSION = "12.0";

export class ProgramTypeError extends TypeError {
  constructor(msg: string) { super(msg); this.name = "ProgramTypeError"; }
}

let session: Session | undefined;
let launcher: PyGhidraLauncher | undefined;
let starting: Promise<Session> | undefined;

/** The live bridge session (throws before `start()`). */
export function jvm(): Session {
  if (!session) throw new Error("Ghidra not started: call start() first");
  return session;
}

export function started(): boolean { return session !== undefined && !session.closed; }

export abstract class PyGhidraLauncher {
  static hasLaunched(): boolean { return started(); }
  protected opts: StartOptions;
  protected extraClasspath: string[] = [];
  protected extraVmargs: string[] = [];
  constructor(opts: { verbose?: boolean; installDir?: string; maxMemory?: string } = {}) { this.opts = { ...opts }; }
  get installDir(): string | undefined { return this.opts.installDir ?? process.env.GHIDRA_INSTALL_DIR; }
  /** pyghidra add_classpath */
  addClasspath(path: string) { this.extraClasspath.push(path); }
  /** pyghidra add_vmargs */
  addVmargs(...args: string[]) { this.extraVmargs.push(...args); }
  protected abstract initGhidra(s: Session): Promise<void>;
  /** Concurrent callers share one JVM; the session is published only after initGhidra succeeds. */
  start(): Promise<Session> {
    if (started()) {
      if (this.extraClasspath.length || this.extraVmargs.length)
        process.stderr.write("ghidra: JVM already started; classpath/vmargs of this launcher are ignored\n");
      return Promise.resolve(session!);
    }
    if (!starting) {
      starting = (async () => {
        const s = await Session.start({ ...this.opts, jvmArgs: [...this.extraVmargs, ...(this.opts.jvmArgs ?? [])], classpath: [...this.extraClasspath, ...(this.opts.classpath ?? [])] });
        try {
          await this.initGhidra(s);
        } catch (e) {
          await s.close().catch(() => {});
          throw e;
        }
        session = s;
        launcher = this;
        return s;
      })().finally(() => { starting = undefined; });
    }
    return starting;
  }
}

export class HeadlessPyGhidraLauncher extends PyGhidraLauncher {
  protected async initGhidra(s: Session) {
    const layout = await s.newObject("ghidra.GhidraApplicationLayout");
    const config = await s.newObject("ghidra.framework.HeadlessGhidraApplicationConfiguration");
    await s.cls("ghidra.framework.Application").initializeApplication(layout, config);
  }
}

/** Starts the JVM but defers Ghidra initialization (classpath/vmargs can be adjusted before start()). */
export class DeferredPyGhidraLauncher extends HeadlessPyGhidraLauncher {
  /** Ghidra initialization is deferred: call `initializeGhidra()` after adjusting classpath/vmargs. */
  protected override async initGhidra(): Promise<void> {}
  async initializeGhidra(): Promise<void> {
    await super.initGhidra(await this.start());
  }
}

export class GuiPyGhidraLauncher extends PyGhidraLauncher {
  protected async initGhidra(): Promise<void> {
    throw new Error("GuiPyGhidraLauncher requires a display; use HeadlessPyGhidraLauncher");
  }
}

export async function start(verbose = false, opts: { installDir?: string } = {}): Promise<PyGhidraLauncher> {
  const l = new HeadlessPyGhidraLauncher({ verbose, installDir: opts.installDir });
  await l.start();
  return l;
}

async function ensureStarted(): Promise<Session> {
  if (!started()) await new HeadlessPyGhidraLauncher().start();
  return session!;
}

export async function stop(): Promise<void> {
  headlessInterpreter = undefined;
  if (session) await session.close();
  session = undefined;
  launcher = undefined;
}

// ---- projects ----------------------------------------------------------------------------------

export async function openProject(path: string, name: string, create = false): Promise<JObject> {
  const s = await ensureStarted();
  const locator = await s.newObject("ghidra.framework.model.ProjectLocator", path, name);
  const pm = await s.newObject("ghidra.pyghidra.PyGhidraProjectManager");
  if (await locator.exists()) return pm.openProject(locator, false, true);
  if (create) return pm.createProject(locator, null, true);
  throw Object.assign(new Error(`Project "${name}" not found at "${path}"!`), { code: "ENOENT", name: "FileNotFoundError" });
}

export async function openFilesystem(path: string): Promise<JObject> {
  const s = await ensureStarted();
  const File = s.cls("java.io.File");
  const svc = await s.cls("ghidra.formats.gfilesystem.FileSystemService").getInstance();
  const fsrl = await (await svc.getLocalFS()).getLocalFSRL(await File.new_(path));
  const fs = await svc.openFileSystemContainer(fsrl, await taskMonitor());
  if (fs === null) throw new Error(`"${await fsrl.toString()}" is not a supported GFileSystem!`);
  return fs;
}

export async function consumeProgram(project: JObject, path: string, consumer?: JObject): Promise<[JObject, JObject]> {
  const s = jvm();
  const consumer_: JObject = consumer ?? (await s.newObject("java.lang.Object"));
  const pd = await project.getProjectData();
  const df = await pd.getFile(path);
  if (df === null) throw Object.assign(new Error(`"${path}" does not exist in the Project`), { name: "FileNotFoundError" });
  const dobj = await df.getDomainObject(consumer_, true, false, await taskMonitor());
  if (!(await dobj.$instanceOf("ghidra.program.model.listing.Program"))) {
    await dobj.release(consumer_);
    throw new ProgramTypeError(`"${path}" exists but is not a Program`);
  }
  return [dobj, consumer_];
}

export async function programContext<T>(project: JObject, path: string, fn: (program: JObject) => Promise<T> | T): Promise<T> {
  const [program, consumer] = await consumeProgram(project, path);
  try { return await fn(program); } finally { await program.release(consumer); }
}

export async function analyze(program: JObject, monitor?: JObject): Promise<string> {
  const s = jvm();
  monitor ??= await taskMonitor();
  const Util = s.cls("ghidra.app.script.GhidraScriptUtil");
  return transaction(program, "Analyze", async () => {
    await Util.acquireBundleHostReference();
    try {
      const mgr = await s.cls("ghidra.app.plugin.core.analysis.AutoAnalysisManager").getAnalysisManager(program);
      await mgr.initializeOptions();
      await mgr.reAnalyzeAll(null);
      await mgr.startAnalysis(monitor, true);
      if (!(await monitor.isCancelled())) await monitor.cancel();
      await s.cls("ghidra.program.util.GhidraProgramUtilities").markProgramAnalyzed(program);
      return String(await (await mgr.getMessageLog()).toString());
    } finally {
      await Util.releaseBundleHostReference();
    }
  });
}

export async function transaction<T>(program: JObject, description: string, fn: (id: number) => Promise<T> | T): Promise<T>;
export async function transaction<T>(program: JObject, fn: (id: number) => Promise<T> | T): Promise<T>;
export async function transaction<T>(program: JObject, a: string | ((id: number) => Promise<T> | T), b?: (id: number) => Promise<T> | T): Promise<T> {
  const desc = typeof a === "string" ? a : "Unnamed Transaction";
  const fn = (typeof a === "string" ? b : a)!;
  const id = await program.startTransaction(desc);
  let ok = true;
  try { return await fn(id); } catch (e) { ok = false; throw e; } finally { await program.endTransaction(id, ok); }
}

export async function analysisProperties(program: JObject): Promise<JObject> {
  const s = jvm();
  await (await s.cls("ghidra.app.plugin.core.analysis.AutoAnalysisManager").getAnalysisManager(program)).initializeOptions();
  return program.getOptions(await s.cls("ghidra.program.model.listing.Program").$field("ANALYSIS_PROPERTIES"));
}

export async function programInfo(program: JObject): Promise<JObject> {
  return program.getOptions(await jvm().cls("ghidra.program.model.listing.Program").$field("PROGRAM_INFO"));
}

export async function programLoader(): Promise<JObject> {
  return (await ensureStarted()).cls("ghidra.app.util.importer.ProgramLoader").builder();
}

export async function taskMonitor(timeout?: number): Promise<JObject> {
  const s = await ensureStarted();
  if (timeout === undefined) return s.cls("ghidra.util.task.TaskMonitor").$field("DUMMY");
  return s.newObject("ghidra.pyghidra.PyGhidraTaskMonitor", timeout, null);
}

export async function walkProject(
  project: JObject, callback: (f: JObject) => Promise<void> | void, startPath = "/",
  fileFilter: (f: JObject) => Promise<boolean> | boolean = () => true,
): Promise<void> {
  const s = jvm();
  const start = await (await project.getProjectData()).getFolder(startPath);
  if (start === null) throw Object.assign(new Error(`Starting folder "${startPath}" does not exist in the Project`), { name: "FileNotFoundError" });
  const files = await (await s.cls("ghidra.framework.model.ProjectDataUtils").descendantFiles(start)).$list();
  for (const f of files) if (await fileFilter(f)) await callback(f);
}

export async function walkPrograms(
  project: JObject, callback: (f: JObject, p: JObject) => Promise<void> | void, startPath = "/",
  programFilter: (f: JObject, p: JObject) => Promise<boolean> | boolean = () => true,
): Promise<void> {
  await walkProject(project, async (file) => {
    try {
      await programContext(project, await file.getPathname(), async (p) => {
        if (await programFilter(file, p)) await callback(file, p);
      });
    } catch (e) {
      if (!(e instanceof ProgramTypeError)) throw e;
    }
  }, startPath);
}

/** Runs any GhidraScript (Java etc.) from `path`; returns [stdout, stderr]. */
export async function ghidraScript(
  path: string, project: JObject, program?: JObject | null, scriptArgs: string[] = [], echoStdout = true, echoStderr = true,
): Promise<[string, string]> {
  const s = jvm();
  const Util = s.cls("ghidra.app.script.GhidraScriptUtil");
  await Util.acquireBundleHostReference();
  try {
    const File = s.cls("java.io.File");
    const src = await s.newObject("generic.jar.ResourceFile", await File.new_(path));
    if (!(await src.exists())) throw new TypeError(`"${await src.toString()}" was not found`);
    const provider = await Util.getProvider(src);
    if (provider === null) throw new TypeError(`"${path}" is not a supported GhidraScript`);
    const sys = await s.cls("java.lang.System").$field("out");
    const script = await provider.getScriptInstance(src, await s.newObject("java.io.PrintWriter", sys));
    if (script === null) throw new TypeError(`"${await src.toString()}" was not found`);
    const state = await s.newObject("ghidra.app.script.GhidraState", null, project, program ?? null, null, null, null);
    const so = await s.newObject("java.io.StringWriter");
    const se = await s.newObject("java.io.StringWriter");
    const controls = await s.newObject("ghidra.app.script.ScriptControls",
      await s.newObject("java.io.PrintWriter", so, true), await s.newObject("java.io.PrintWriter", se, true), await taskMonitor());
    await script.setScriptArgs(Session.array("java.lang.String", scriptArgs));
    await script.execute(state, controls);
    const out = String(await so.toString()), err = String(await se.toString());
    if (echoStdout) process.stdout.write(out);
    if (echoStderr) process.stderr.write(err);
    return [out, err];
  } finally {
    await Util.releaseBundleHostReference();
  }
}

// ---- open_program (deprecated in pyghidra, still the common entry) ----------------------------------

export interface OpenProgramOptions {
  projectLocation?: string;
  projectName?: string;
  analyze?: boolean;
  language?: string;
  compiler?: string;
  loader?: string;
  programName?: string;
  nestedProjectLocation?: boolean;
}

export interface ProgramHandle extends AsyncDisposable {
  /** ghidra.program.flatapi.FlatProgramAPI */
  flat: JObject;
  program: JObject;
  project: JObject;
  close(): Promise<void>;
  /** GhidraScript-like flat context (println, ask*, getFunctionAt, ...) */
  script: Flat;
}

async function getLanguage(s: Session, id: string): Promise<JObject> {
  try {
    const svc = await s.cls("ghidra.program.util.DefaultLanguageService").getLanguageService();
    return await svc.getLanguage(await s.newObject("ghidra.program.model.lang.LanguageID", id));
  } catch (e: any) {
    if (e?.type === "ghidra.program.model.lang.LanguageNotFoundException") throw new Error("Invalid Language ID: " + id);
    throw e;
  }
}

async function getCompilerSpec(s: Session, lang: JObject, compiler?: string): Promise<JObject> {
  if (compiler === undefined) return lang.getDefaultCompilerSpec();
  try {
    return await lang.getCompilerSpecByID(await s.newObject("ghidra.program.model.lang.CompilerSpecID", compiler));
  } catch (e: any) {
    if (e?.type === "ghidra.program.model.lang.CompilerSpecNotFoundException")
      throw new Error(`Invalid CompilerSpecID: ${compiler} for Language: ${await (await lang.getLanguageID()).toString()}`);
    throw e;
  }
}

export async function openProgram(binaryPath: string | null, o: OpenProgramOptions = {}): Promise<ProgramHandle> {
  const s = await ensureStarted();
  const bp = binaryPath === null ? null : resolve(binaryPath);
  const programName = o.programName ?? (bp ? basename(bp) : undefined);
  const projectName = o.projectName || `${basename(bp ?? "program")}_ghidra`;
  if (bp === null && !o.projectLocation) throw new Error("openProgram(null) requires projectLocation");
  let loc = o.projectLocation ? resolve(o.projectLocation) : dirname(bp!);
  if (o.nestedProjectLocation ?? true) loc = join(loc, projectName);
  const GP = s.cls("ghidra.base.project.GhidraProject");
  let loaderCls: unknown = undefined;
  if (o.loader) {
    const Class = s.cls("java.lang.Class");
    try { loaderCls = await Class.forName(o.loader); } catch (e: any) {
      if (e?.type === "java.lang.ClassNotFoundException") throw new Error(`Invalid loader ${o.loader}`);
      throw e;
    }
    const iface = await Class.forName("ghidra.app.util.opinion.Loader");
    if (!(await iface.isAssignableFrom(loaderCls))) throw new TypeError(`${o.loader} does not implement ghidra.app.util.opinion.Loader`);
  }
  const locator = await s.newObject("ghidra.framework.model.ProjectLocator", loc, projectName);
  const Util = s.cls("ghidra.app.script.GhidraScriptUtil");
  let acquired = 0;
  let project!: JObject;
  try {
  if (await locator.exists()) project = await GP.openProject(loc, projectName, true);
  else {
    mkdirSync(loc, { recursive: true });
    project = await GP.createProject(loc, projectName, false);
  }
  let program: JObject | null = null;
  if (programName !== undefined && (await (await project.getRootFolder()).getFile(programName)) !== null)
    program = await project.openProgram("/", programName, false);
  if (bp !== null && program === null) {
    if (o.language === undefined) {
      program = loaderCls === undefined ? await project.importProgram(bp) : await project.importProgram(bp, loaderCls);
      if (program === null) throw new Error(`Ghidra failed to import '${bp}'. Try providing a language manually.`);
    } else {
      const lang = await getLanguage(s, o.language);
      const comp = await getCompilerSpec(s, lang, o.compiler);
      program = loaderCls === undefined ? await project.importProgram(bp, lang, comp) : await project.importProgram(bp, loaderCls, lang, comp);
      if (program === null) throw new Error(`Ghidra failed to import '${bp}'. The provided language (${o.language}) may be invalid.`);
    }
    await project.saveAs(program, "/", programName, true);
  }
  if (program === null) throw new Error(programName === undefined ? "no program to open" : `program '${programName}' not found in project ${projectName}`);
  await Util.acquireBundleHostReference();
  acquired++;
  const flat = await s.newObject("ghidra.program.flatapi.FlatProgramAPI", program);
  if (o.analyze ?? true) {
    const PU = s.cls("ghidra.program.util.GhidraProgramUtilities");
    if (await PU.shouldAskToAnalyze(program)) {
      await Util.acquireBundleHostReference();
      try {
        await flat.analyzeAll(program);
        await PU.markProgramAnalyzed(program);
      } finally { await Util.releaseBundleHostReference(); }
    }
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await Util.releaseBundleHostReference(); } finally {
      try { await project.save(program); } finally { await project.close(); }
    }
  };
  const script = createFlat({ callFlat: (m, a) => (flat as any)[m](...a) }, { scriptName: "bun-ghidra" });
  return { flat, program: program!, project, close, script, [Symbol.asyncDispose]: close };
  } catch (e) {
    // do not leak the bundle-host reference or the open project when open/import/analysis fails
    for (; acquired > 0; acquired--) await Util.releaseBundleHostReference().catch(() => {});
    await project?.close().catch(() => {});
    throw e;
  }
}

/** Python `with open_program(...) as flat_api:` equivalent. */
export async function withProgram<T>(binaryPath: string | null, o: OpenProgramOptions, fn: (h: ProgramHandle) => Promise<T>): Promise<T> {
  const h = await openProgram(binaryPath, o);
  try { return await fn(h); } finally { await h.close(); }
}

// ---- scripts ---------------------------------------------------------------------------------------

/** pyghidra.get_current_interpreter: the script context of the running bun-ghidra script, if any. */
let headlessInterpreter: ScriptContext | undefined;
export function getCurrentInterpreter(): ScriptContext | undefined {
  const c = getContext();
  if (c) return c;
  if (!started()) return undefined;
  // pyghidra headless: a default script with no program
  return (headlessInterpreter ??= { session: jvm(), flat: createFlat({ callFlat: async () => { throw new Error("no current program"); } }), scriptName: "interpreter" });
}

/**
 * pyghidra.run_script analogue: open `binaryPath`, expose the script context (see `@aphrody/ghidra/script`)
 * and `import()` the TS/JS script at `scriptPath`.
 */
export async function runScript(
  binaryPath: string | null, scriptPath: string, o: OpenProgramOptions & { scriptArgs?: string[]; verbose?: boolean } = {},
): Promise<void> {
  const h = await openProgram(binaryPath, o);
  try {
    const program = h.program;
    const mem = await (await program.getMemory()).getLoadedAndInitializedAddressSet();
    const currentAddress = (await mem.isEmpty()) ? null : await mem.getMinAddress();
    const scriptName = basename(scriptPath);
    const flat = createFlat({ callFlat: (m, a) => (h.flat as any)[m](...a) }, { scriptName, scriptArgs: o.scriptArgs ?? [] });
    setContext({ session: jvm(), project: h.project, currentProgram: program, currentAddress, currentLocation: null, currentSelection: null, currentHighlight: null, state: null, monitor: await taskMonitor(), flat, scriptArgs: o.scriptArgs ?? [], scriptName, sourceFile: resolve(scriptPath), javaFlat: h.flat });
    await import(pathToFileURL(resolve(scriptPath)).href + "?run=" + Date.now());
  } finally {
    clearContext();
    await h.close();
  }
}

export function debugCallback<F extends (...a: any[]) => any>(fn: F): F { return fn; }

// ---- version helpers (pyghidra.version) -------------------------------------------------------------

export class ApplicationInfo {
  constructor(
    public name: string, public version: string, public release_name: string, public revision_ghidra = "",
    public build_date = "", public build_date_short = "", public layout_version = "", public gradle_min = "",
    public java_min = "", public java_max = "", public java_compiler = "", public gradle_max = "",
  ) {}
  static fromFile(file: string): ApplicationInfo {
    const kv: Record<string, string> = {};
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("#") || line.startsWith("!")) continue;
      const m = line.match(/^application\.(\S+?)\s*=\s*(.*)$/);
      if (m) kv[m[1]!.replace(/[.-]/g, "_")] = m[2]!.trim();
    }
    for (const req of ["name", "version", "release_name"]) if (kv[req] === undefined) throw new Error(`${file}: missing application.${req.replace(/_/g, ".")}`);
    return new ApplicationInfo(kv.name!, kv.version!, kv.release_name!, kv.revision_ghidra, kv.build_date, kv.build_date_short,
      kv.layout_version, kv.gradle_min, kv.java_min, kv.java_max, kv.java_compiler, kv.gradle_max);
  }
}

export class ExtensionDetails {
  constructor(public name: string, public description: string, public author: string,
    public createdOn = String(new Date()), public version: string | null = null, public plugin_version = "0.0.1") {}
  static fromFile(file: string): ExtensionDetails {
    const kv: Record<string, string> = {};
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("#") || line.startsWith("!")) continue;
      const i = line.indexOf("=");
      if (i >= 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    for (const req of ["name", "description", "author"]) if (kv[req] === undefined) throw new Error(`${file}: missing ${req}`);
    return new ExtensionDetails(kv.name!, kv.description!, kv.author!, kv.createdOn, kv.version ?? null, kv.plugin_version);
  }
  toString() {
    return Object.entries(this).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}=${v}`).join("\n");
  }
}

