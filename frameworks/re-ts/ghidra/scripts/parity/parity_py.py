"""pyghidra side of the parity run. usage: parity_py.py <workdir> <out.json>
Every entry id (api.* = pyghidra public API, ops.* = Ghidra program operations) must match scripts/parity/parity.ts."""
import json, os, sys, tempfile, functools

work, out = sys.argv[1], sys.argv[2]
install = os.environ["GHIDRA_INSTALL_DIR"]
R = {}
E = {}


def entry(name):
    def deco(fn):
        try:
            R[name] = fn()
        except Exception as e:  # record the failure class only, messages differ by runtime
            R[name] = {"error": type(e).__name__}
            E[name] = str(e)[:400]
        return fn
    return deco


import pyghidra

R["api.started.before"] = pyghidra.started()
launcher = pyghidra.start(install_dir=install)
R["api.start"] = pyghidra.started()
R["api.surface"] = sorted(pyghidra.__all__)
json.dump(sorted(pyghidra.__all__), open(os.path.join(work, "all.json"), "w"))

from ghidra.program.model.listing import Program
from java.lang import String as JString

binpath = os.path.join(work, "tiny")
projloc = os.path.join(work, "proj_py")

with pyghidra.open_program(binpath, project_location=projloc, project_name="p", analyze=True) as flat:
    program = flat.getCurrentProgram()
    R["api.open_program"] = {"name": str(program.getName()), "flat": type(flat).__name__ == "FlatProgramAPI" or "FlatProgramAPI" in str(type(flat))}
    fm = program.getFunctionManager()
    listing = program.getListing()
    st = program.getSymbolTable()
    rm = program.getReferenceManager()
    mem = program.getMemory()
    dtm = program.getDataTypeManager()
    mon = pyghidra.task_monitor()

    def fn(name):
        return list(fm.getFunctions(True))[[str(f.getName()) for f in fm.getFunctions(True)].index(name)]

    compute = fn("compute")
    add = fn("add")

    @entry("ops.program.name")
    def _(): return str(program.getName())

    @entry("ops.program.language")
    def _(): return str(program.getLanguageID())

    @entry("ops.program.compiler")
    def _(): return str(program.getCompilerSpec().getCompilerSpecID())

    @entry("ops.program.format")
    def _(): return str(program.getExecutableFormat())

    @entry("ops.program.imageBase")
    def _(): return str(program.getImageBase())

    @entry("ops.functions.count")
    def _(): return int(fm.getFunctionCount())

    @entry("ops.functions.list")
    def _(): return sorted([str(f.getName()), str(f.getEntryPoint()), int(f.getBody().getNumAddresses())] for f in fm.getFunctions(True))

    @entry("ops.functions.global")
    def _(): return [str(f.getEntryPoint()) for f in flat.getGlobalFunctions("compute")]

    @entry("ops.functions.at")
    def _(): return str(flat.getFunctionAt(compute.getEntryPoint()).getName())

    @entry("ops.functions.containing")
    def _(): return str(flat.getFunctionContaining(compute.getEntryPoint().add(2)).getName())

    @entry("ops.functions.first_last")
    def _(): return [str(flat.getFirstFunction().getName()), str(flat.getLastFunction().getName())]

    @entry("ops.function.signature")
    def _(): return str(compute.getSignature().getPrototypeString())

    @entry("ops.function.callingConvention")
    def _(): return str(compute.getCallingConventionName())

    @entry("ops.function.params")
    def _(): return [[str(p.getName()), str(p.getDataType().getName())] for p in compute.getParameters()]

    @entry("ops.function.callees")
    def _(): return sorted(str(f.getName()) for f in compute.getCalledFunctions(mon))

    @entry("ops.function.callers")
    def _(): return sorted(str(f.getName()) for f in add.getCallingFunctions(mon))

    @entry("ops.function.stackFrame")
    def _(): return int(compute.getStackFrame().getFrameSize())

    @entry("ops.listing.instructions")
    def _():
        return [[str(i.getAddress()), str(i.getMnemonicString()), str(i)] for i in listing.getInstructions(compute.getBody(), True)]

    @entry("ops.listing.counts")
    def _(): return [int(listing.getNumCodeUnits()), int(listing.getNumInstructions()), int(listing.getNumDefinedData())]

    @entry("ops.flat.instructions")
    def _():
        a = flat.getInstructionAt(compute.getEntryPoint())
        return [str(a), str(flat.getInstructionAfter(a)), str(flat.getInstructionContaining(compute.getEntryPoint().add(1)))]

    @entry("ops.symbols.count")
    def _(): return int(st.getNumSymbols())

    @entry("ops.symbols.names")
    def _(): return sorted(str(s.getName(True)) for s in st.getAllSymbols(True))

    @entry("ops.symbols.primary")
    def _(): return str(st.getPrimarySymbol(compute.getEntryPoint()).getName())

    @entry("ops.symbols.flat")
    def _(): return [str(s) for s in flat.getSymbols("compute", None)]

    @entry("ops.refs.to")
    def _(): return sorted([str(r.getFromAddress()), str(r.getReferenceType())] for r in flat.getReferencesTo(add.getEntryPoint()))

    @entry("ops.refs.from")
    def _(): return sorted([str(r.getToAddress()), str(r.getReferenceType())] for r in flat.getReferencesFrom(compute.getEntryPoint().add(4)))

    @entry("ops.refs.count")
    def _(): return int(rm.getReferenceSourceCount())

    @entry("ops.datatypes.root")
    def _():
        c = dtm.getRootCategory()
        return [str(dtm.getName()), str(c.getName()), len(list(c.getCategories()))]

    @entry("ops.datatypes.count")
    def _(): return int(dtm.getDataTypeCount(True))

    @entry("ops.memory.blocks")
    def _(): return sorted([str(b.getName()), str(b.getStart()), str(b.getEnd()), int(b.getSize()), bool(b.isRead()), bool(b.isWrite()), bool(b.isExecute())] for b in mem.getBlocks())

    @entry("ops.memory.bytes")
    def _(): return bytes(b & 0xFF for b in flat.getBytes(compute.getEntryPoint(), 16)).hex()

    @entry("ops.memory.int")
    def _(): return int(flat.getInt(compute.getEntryPoint()))

    @entry("ops.memory.contains")
    def _(): return [bool(mem.contains(compute.getEntryPoint())), bool(mem.contains(flat.toAddr(0x10)))]

    @entry("ops.address.toAddr")
    def _(): return [str(flat.toAddr(0x401000)), str(flat.getAddressFactory().getDefaultAddressSpace().getName())]

    @entry("ops.find.bytes")
    def _():
        a = flat.findBytes(program.getMinAddress(), "\\x55\\x48\\x89\\xe5")
        return str(a)

    @entry("ops.find.strings")
    def _(): return len(list(flat.findStrings(None, 4, 1, True, True)))

    @entry("ops.namespace.global")
    def _(): return str(program.getGlobalNamespace().getName())

    @entry("ops.entrypoints")
    def _(): return sorted(str(a) for a in st.getExternalEntryPointIterator())

    @entry("ops.blocks.basic")
    def _():
        from ghidra.program.model.block import BasicBlockModel
        m = BasicBlockModel(program)
        return sorted([str(b.getFirstStartAddress()), int(b.getNumAddresses())] for b in m.getCodeBlocksContaining(compute.getBody(), mon))

    @entry("ops.relocations")
    def _(): return int(program.getRelocationTable().getSize())

    @entry("ops.decompile.compute")
    def _():
        from ghidra.app.decompiler import DecompInterface
        d = DecompInterface()
        d.openProgram(program)
        r = d.decompileFunction(compute, 60, mon)
        c = str(r.getDecompiledFunction().getC())
        d.dispose()
        return c

    @entry("ops.decompile.all")
    def _():
        from ghidra.app.decompiler import DecompInterface
        d = DecompInterface()
        d.openProgram(program)
        n = 0
        for f in fm.getFunctions(True):
            if d.decompileFunction(f, 60, mon).decompileCompleted():
                n += 1
        d.dispose()
        return n

    @entry("ops.pcode.high")
    def _():
        from ghidra.app.decompiler import DecompInterface
        d = DecompInterface()
        d.openProgram(program)
        hf = d.decompileFunction(compute, 60, mon).getHighFunction()
        ops = [str(o.getMnemonic()) for o in hf.getPcodeOps()]
        d.dispose()
        return ops

    @entry("ops.pcode.raw")
    def _():
        i = flat.getInstructionAt(compute.getEntryPoint())
        return [str(o.getMnemonic()) for o in i.getPcode()]

    @entry("ops.mutate.comment_label_bookmark")
    def _():
        a = compute.getEntryPoint().add(4)
        with pyghidra.transaction(program, "mutate"):
            flat.setEOLComment(a, "parity-comment")
            flat.createLabel(a, "parity_label", True)
            flat.createBookmark(a, "Parity", "note")
        return [str(flat.getEOLComment(a)), [str(s.getName()) for s in flat.getSymbols("parity_label", None)], len(list(flat.getBookmarks(a)))]

    @entry("ops.mutate.rollback")
    def _():
        a = compute.getEntryPoint().add(8)
        try:
            with pyghidra.transaction(program, "bad"):
                flat.setEOLComment(a, "rolled-back")
                raise RuntimeError("x")
        except RuntimeError:
            pass
        return flat.getEOLComment(a) is None

    @entry("api.transaction.id")
    def _():
        with pyghidra.transaction(program, "t") as tid:
            return int(tid) > 0

    @entry("api.analysis_properties")
    def _(): return sorted(str(n) for n in pyghidra.analysis_properties(program).getOptionNames())[:60]

    @entry("api.program_info")
    def _(): return sorted(str(n) for n in pyghidra.program_info(program).getOptionNames())

    @entry("api.analyze.log_nonempty")
    def _(): return isinstance(pyghidra.analyze(program), str)

R["api.program_loader"] = str(pyghidra.program_loader().getClass().getName())
R["api.task_monitor.default"] = str(pyghidra.task_monitor().getClass().getName())
R["api.task_monitor.timeout"] = str(pyghidra.task_monitor(5).getClass().getName())

project = pyghidra.open_project(os.path.join(projloc, "p"), "p")
R["api.open_project"] = str(project.getProject().getName()) if hasattr(project, "getProject") else str(project.getName())


@entry("api.open_project.missing")
def _():
    try:
        pyghidra.open_project(os.path.join(projloc, "p"), "does_not_exist")
    except FileNotFoundError:
        return "FileNotFoundError"


@entry("api.open_project.create")
def _():
    os.makedirs(os.path.join(work, "proj_new"), exist_ok=True)
    p = pyghidra.open_project(os.path.join(work, "proj_new"), "n", create=True)
    n = str(p.getName())
    p.close()
    return n


@entry("api.program_context")
def _():
    with pyghidra.program_context(project, "/tiny") as p:
        return str(p.getName())


@entry("api.consume_program")
def _():
    p, c = pyghidra.consume_program(project, "/tiny")
    n = str(p.getName())
    p.release(c)
    return n


@entry("api.consume_program.missing")
def _():
    try:
        pyghidra.consume_program(project, "/nope")
    except FileNotFoundError:
        return "FileNotFoundError"


@entry("api.walk_project")
def _():
    names = []
    pyghidra.walk_project(project, lambda f: names.append(str(f.getPathname())))
    return sorted(names)


@entry("api.walk_programs")
def _():
    names = []
    pyghidra.walk_programs(project, lambda f, p: names.append(str(p.getName())))
    return sorted(names)


@entry("api.open_filesystem")
def _():
    fs = pyghidra.open_filesystem(os.path.join(work, "tiny.zip"))
    return [str(fs.getType()), int(fs.getFileCount())]


@entry("api.open_filesystem.unsupported")
def _():
    try:
        pyghidra.open_filesystem(os.path.join(work, "plain.txt"))
        return "opened"
    except ValueError:
        return "ValueError"


@entry("api.ghidra_script")
def _():
    out, err = pyghidra.ghidra_script(os.path.join(work, "Hello.java"), project, None, ["a", "b"], echo_stdout=False, echo_stderr=False)
    return [str(out).strip(), str(err).strip()]


@entry("api.ApplicationInfo")
def _():
    from pathlib import Path
    a = pyghidra.ApplicationInfo.from_file(Path(install) / "Ghidra" / "application.properties")
    return [a.name, a.version, a.release_name, a.java_min, a.build_date_short, a.layout_version]


@entry("api.ExtensionDetails")
def _():
    from pathlib import Path
    e = pyghidra.ExtensionDetails.from_file(Path(work) / "extension.properties")
    return [e.name, e.description, e.author, e.version, e.plugin_version]


@entry("api.debug_callback")
def _():
    f = pyghidra.debug_callback(lambda x: x + 1)
    return f(1)


@entry("api.get_current_interpreter")
def _(): return pyghidra.get_current_interpreter() is not None


@entry("api.launchers")
def _():
    return [issubclass(pyghidra.HeadlessPyGhidraLauncher, object), pyghidra.DeferredPyGhidraLauncher.__name__, pyghidra.GuiPyGhidraLauncher.__name__, pyghidra.HeadlessPyGhidraLauncher.__name__]


@entry("api.ProgramTypeError")
def _(): return issubclass(pyghidra.ProgramTypeError, TypeError)


@entry("api.open_program.loader_invalid")
def _():
    try:
        with pyghidra.open_program(os.path.join(work, "tiny"), project_location=os.path.join(work, "proj_l"), analyze=False, loader="java.lang.String"):
            return "opened"
    except TypeError:
        return "TypeError"


@entry("api.open_program.language_invalid")
def _():
    try:
        with pyghidra.open_program(os.path.join(work, "tiny"), project_location=os.path.join(work, "proj_l2"), analyze=False, language="bogus:LE:64:default"):
            return "opened"
    except ValueError:
        return "ValueError"


project.close()

@entry("api.run_script")
def _():
    import io, contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        pyghidra.run_script(os.path.join(work, "tiny"), os.path.join(work, "run_script.py"), project_location=projloc, project_name="p", analyze=False)
    return buf.getvalue().strip()



json.dump(E, open(out + ".err", "w"), indent=1, sort_keys=True)
json.dump(R, open(out, "w"), indent=1, sort_keys=True)
print("entries", len(R))
