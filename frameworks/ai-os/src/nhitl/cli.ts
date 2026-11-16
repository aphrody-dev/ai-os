// ai-os nhitl: SQLite FTS5 index of NHITL violations (doc: frameworks/ai-os/docs/NHITL.md). JSON output on stdout.
//   ai-os nhitl scan [--only transcript,settings,code,queue,docs,hook,ledger] [--local]   rescan reproductible
//   ai-os nhitl list [--source S] [--category C] [--status open|fixed|inevitable] [--severity S] [--q fts] [--limit N]
//   ai-os nhitl stats                                                                      counts per category/status
//   ai-os nhitl set <id> <open|fixed|inevitable> [--reason "…"]                             triage that survives rescans
//   ai-os nhitl login claude|codex [--hosts prd,fr2] [--clipboard]                                     sign-in flow without typing
import { parseArgs } from "node:util";
import { Index, type Source, type Status } from "./index";
import { scan } from "./scan";

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    only: { type: "string" },
    local: { type: "boolean" },
    source: { type: "string" },
    category: { type: "string" },
    status: { type: "string" },
    severity: { type: "string" },
    q: { type: "string" },
    limit: { type: "string" },
    reason: { type: "string" },
    hosts: { type: "string" },
    clipboard: { type: "boolean" },
  },
});
const [cmd, ...rest] = positionals;
const print = (x: unknown) => console.log(JSON.stringify(x, null, 2));

switch (cmd) {
  case "scan": {
    const ix = new Index();
    const only = values.only ? (values.only.split(",") as Source[]) : undefined;
    const report = await scan(ix, only, values.local);
    print({ report, ...ix.stats() });
    ix.close();
    break;
  }
  case "list": {
    const ix = new Index();
    print(
      ix.list({
        source: values.source,
        category: values.category,
        status: values.status,
        severity: values.severity,
        q: values.q,
        limit: values.limit ? Number(values.limit) : undefined,
      }),
    );
    ix.close();
    break;
  }
  case "stats": {
    const ix = new Index();
    print(ix.stats());
    ix.close();
    break;
  }
  case "set": {
    const [id, status] = rest;
    if (!id || !["open", "fixed", "inevitable"].includes(status ?? ""))
      throw new Error(
        "usage : ai-os nhitl set <id> <open|fixed|inevitable> [--reason …]",
      );
    const ix = new Index();
    ix.triage(id, status as Status, values.reason);
    print({ id, status, reason: values.reason ?? null });
    ix.close();
    break;
  }
  case "login": {
    const { login } = await import("./login");
    print(
      await login(
        rest[0] ?? "",
        values.hosts?.split(",").filter(Boolean) ?? undefined,
        30,
        values.clipboard ?? false,
      ),
    );
    break;
  }
  default:
    console.error(
      "usage : ai-os nhitl scan [--only sources] [--local] | list [--source|--category|--status|--severity|--q|--limit] | stats | set <id> <status> [--reason] | login claude|codex [--hosts prd,fr2]",
    );
    process.exit(2);
}
