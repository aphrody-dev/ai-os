// Aphrody core tools exposed through @aphrody/ai-os (MCP, A2A, JSON-RPC):
// AST Tree-sitter, Ghidra P-Code/Pseudo-C, RE, MinGW-REA, Migration, LLVM IR, .NET bindgen.
import { s } from "../llm/schema";
import type { Tool } from "./tools.ts";

export const CORE_TOOLS: Tool[] = [
  {
    name: "core_parse",
    description:
      "Parse source code into AST symbols, calls, and imports via Aphrody Tree-sitter C ABI (@aphrody/core).",
    inputSchema: s.object({
      path: s.string("Virtual or repo path with file extension (e.g. app.ts)"),
      content: s.string("Source file text"),
    }),
    readOnly: true,
    run: async (a) => {
      const { parse } = await import("@aphrody/core");
      return parse(String(a.path), String(a.content));
    },
  },
  {
    name: "core_query",
    description:
      "Execute a Tree-sitter S-expression query over source text via @aphrody/core.",
    inputSchema: s.object({
      path: s.string("Path with extension selecting the language grammar"),
      content: s.string("Source file text"),
      sexpr: s.string("Tree-sitter S-expression query"),
    }),
    readOnly: true,
    run: async (a) => {
      const { query } = await import("@aphrody/core");
      return query(String(a.path), String(a.content), String(a.sexpr));
    },
  },
  {
    name: "core_index",
    description:
      "Index a repository tree via @aphrody/core Tree-sitter + BLAKE3 C ABI.",
    inputSchema: s.object(
      {
        root: s.string("Root directory path"),
        includes: s.array(s.string("Glob or prefix filter"), {
          description: "Optional include filters",
        }),
        followIgnore: s.boolean("Respect .gitignore (default true)"),
      },
      ["includes", "followIgnore"],
    ),
    readOnly: true,
    run: async (a) => {
      const { index } = await import("@aphrody/core");
      return index(String(a.root), {
        includes: Array.isArray(a.includes)
          ? a.includes.map(String)
          : undefined,
        followIgnore:
          typeof a.followIgnore === "boolean" ? a.followIgnore : true,
      });
    },
  },
  {
    name: "core_pipeline",
    description:
      "Incrementally index a tree into the shared SQLite (WAL, FTS5; same file as `ay index`): unchanged files cost one stat, results are BLAKE3-addressed. Returns the run report.",
    inputSchema: s.object(
      {
        root: s.string("Root directory path"),
        db: s.string("SQLite path (default <root>/var/index/core.db)"),
        includes: s.array(s.string("Sub-path of root"), {
          description: "Optional sub-paths",
        }),
        all: s.boolean("Also descend into gitignored trees (third_party)"),
      },
      ["db", "includes", "all"],
    ),
    readOnly: false,
    run: async (a) => {
      const { pipelineRun } = await import("@aphrody/core");
      const root = String(a.root);
      return pipelineRun(
        root,
        a.db ? String(a.db) : `${root}/var/index/core.db`,
        {
          includes: Array.isArray(a.includes)
            ? a.includes.map(String)
            : undefined,
          followIgnore: a.all !== true,
          shared: true,
        },
      );
    },
  },
  {
    name: "core_symbols",
    description:
      "Look up symbols in the shared index SQLite (trigram FTS5 substring or exact name), no re-parse.",
    inputSchema: s.object(
      {
        db: s.string("SQLite path (default var/index/core.db under SRC_ROOT)"),
        query: s.string("Symbol name or substring"),
        exact: s.boolean("Exact name instead of substring"),
        limit: s.number("Maximum hits (default 20)"),
      },
      ["db", "exact", "limit"],
    ),
    readOnly: true,
    run: async (a) => {
      const { pipelineQuery } = await import("@aphrody/core");
      const root = process.env.SRC_ROOT ?? process.cwd();
      return pipelineQuery(
        a.db ? String(a.db) : `${root}/var/index/core.db`,
        String(a.query),
        typeof a.limit === "number" ? a.limit : 20,
        a.exact === true,
      );
    },
  },
  {
    name: "core_re_audit",
    description:
      "Inspect PE/ELF/Mach-O headers, sections, exports, disassembly, or Lua 5.2 bytecode via Aphrody core RE engine.",
    inputSchema: s.object({
      path: s.string("Absolute or repo path to binary or bytecode artifact"),
    }),
    readOnly: true,
    run: async (a) => {
      const { reAudit } = await import("@aphrody/core");
      return reAudit(String(a.path));
    },
  },
  {
    name: "core_ghidra_decompile",
    description:
      "Lifting x86-64/native functions into CFG basic blocks, Ghidra P-Code IR, and Pseudo-C via @aphrody/core.",
    inputSchema: s.object(
      {
        path: s.string("Path to PE/ELF/Mach-O binary"),
        maxFunctions: s.number("Maximum functions to decompile (default 64)"),
      },
      ["maxFunctions"],
    ),
    readOnly: true,
    run: async (a) => {
      const { ghidraDecompile } = await import("@aphrody/core");
      const maxFn = typeof a.maxFunctions === "number" ? a.maxFunctions : 64;
      return ghidraDecompile(String(a.path), maxFn);
    },
  },
  {
    name: "core_mingw_audit",
    description:
      "Audit a PE binary for MinGW CRT noise filtering and .rea_sig attribution via @aphrody/core.",
    inputSchema: s.object(
      {
        path: s.string("Path to Windows PE binary"),
        maxFunctions: s.number("Maximum functions to analyze (default 64)"),
      },
      ["maxFunctions"],
    ),
    readOnly: true,
    run: async (a) => {
      const { mingwAudit } = await import("@aphrody/core");
      const maxFn = typeof a.maxFunctions === "number" ? a.maxFunctions : 64;
      return mingwAudit(String(a.path), maxFn);
    },
  },
  {
    name: "core_migrate_run",
    description:
      "Run Aphrody AST/manifest migration across a repository (Node/Lua -> Bun/Rust) via @aphrody/core.",
    inputSchema: s.object(
      {
        rootDir: s.string("Repository root directory"),
        dryRun: s.boolean(
          "Preview edits without modifying files (default true)",
        ),
      },
      ["dryRun"],
    ),
    readOnly: false,
    run: async (a) => {
      const { migrateRun } = await import("@aphrody/core");
      return migrateRun(String(a.rootDir), a.dryRun !== false);
    },
  },
  {
    name: "core_migrate_transform",
    description:
      "Transform a single JS/TS/Lua source snippet using Aphrody AST codemods + Helix Rope via @aphrody/core.",
    inputSchema: s.object({
      langOrPath: s.string("Extension, language name (ts/js/tsx/lua), or path"),
      source: s.string("Source text to transform"),
    }),
    readOnly: true,
    run: async (a) => {
      const { transformSource } = await import("@aphrody/core");
      return transformSource(String(a.langOrPath), String(a.source));
    },
  },
  {
    name: "core_llvm_analyze",
    description:
      "Analyze textual LLVM IR (.ll) for functions, basic blocks, SIMD vectorization, and Bun FFI stubs via @aphrody/core.",
    inputSchema: s.object({
      sourceLabel: s.string("Label or path of the LLVM IR module"),
      irText: s.string("LLVM IR text content"),
    }),
    readOnly: true,
    run: async (a) => {
      const { llvmAnalyzeIr } = await import("@aphrody/core");
      return llvmAnalyzeIr(String(a.sourceLabel), String(a.irText));
    },
  },
  {
    name: "core_dotnet_doctor",
    description:
      "Probe host .NET SDK and CoreCLR hostfxr environment via @aphrody/core.",
    inputSchema: s.object({}),
    readOnly: true,
    run: async () => {
      const { dotnetDoctor } = await import("@aphrody/core");
      return dotnetDoctor();
    },
  },
  {
    name: "core_dotnet_bindgen",
    description:
      "Generate C#, Rust, and Bun FFI bindings for C# [JSExport] types via @aphrody/core.",
    inputSchema: s.object(
      {
        csPath: s.string("Path to C# source file"),
        assemblyName: s.string(
          "Target .NET assembly name (default AphrodyNative)",
        ),
      },
      ["assemblyName"],
    ),
    readOnly: true,
    run: async (a) => {
      const { dotnetBindgen } = await import("@aphrody/core");
      return dotnetBindgen(
        String(a.csPath),
        a.assemblyName ? String(a.assemblyName) : "AphrodyNative",
      );
    },
  },
  {
    name: "core_ingest",
    description:
      "Digest a repository into an LLM token-bounded AST outline via @aphrody/core.",
    inputSchema: s.object(
      {
        rootDir: s.string("Directory path to ingest"),
        maxTokens: s.number("Optional token budget (0 = unlimited)"),
        outlineOnly: s.boolean("Emit structure/symbols only without bodies"),
      },
      ["maxTokens", "outlineOnly"],
    ),
    readOnly: true,
    run: async (a) => {
      const { ingestCodebase } = await import("@aphrody/core");
      return ingestCodebase(
        String(a.rootDir),
        typeof a.maxTokens === "number" ? a.maxTokens : 0,
        a.outlineOnly === true,
      );
    },
  },
  {
    name: "core_graph_query",
    description:
      "Query the repository symbol/call graph (BFS or DFS) via @aphrody/core.",
    inputSchema: s.object(
      {
        dir: s.string("Repository root directory"),
        term: s.string("Symbol, file, or concept to query"),
        dfs: s.boolean("Use DFS traversal (default false = BFS)"),
        maxTokens: s.number("Optional response token budget (default 2000)"),
      },
      ["dfs", "maxTokens"],
    ),
    readOnly: true,
    run: async (a) => {
      const { graphQuery } = await import("@aphrody/core");
      return graphQuery(
        String(a.dir),
        String(a.term),
        a.dfs === true,
        typeof a.maxTokens === "number" ? a.maxTokens : 2000,
      );
    },
  },
];
