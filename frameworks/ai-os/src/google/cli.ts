#!/usr/bin/env bun
// `ai-os jules <cmd>` and `ai-os stitch <cmd>` (also `ay jules`, `ay design stitch`): absorbed clients of
// google-labs-code (src/google/jules = jules-sdk core, src/google/stitch = stitch-sdk). JSON output on stdout.
// Jules: JULES_API_KEY if present (vault: `ay secret exec JULES_API_KEY -- ai-os jules ...`), otherwise gcloud OAuth.
// Stitch: STITCH_API_KEY if present, otherwise gcloud OAuth token + quota project (src/google/auth.ts).
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

// Local cache of the Jules SDK outside the repository (otherwise .jules/ in the cwd if it has a package.json).
process.env.JULES_HOME ??= join(
  Bun.env.AGENT_HOME ?? join(homedir(), ".agent"),
  "jules",
);

export const DEFAULT_REPO = Bun.env.JULES_REPO ?? "aphrody-labs/src";

const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const readStdin = async () =>
  (await new Response(Bun.stdin.stream()).text()).trim();

/** src Jules client: JULES_API_KEY if present, otherwise gcloud OAuth (Bearer + quota project). */
export async function julesClient() {
  const { jules } = await import("./jules/index.ts");
  if (Bun.env.JULES_API_KEY) return jules;
  const { gcloudHeaders } = await import("./auth.ts");
  return jules.with({ authHeaders: gcloudHeaders });
}

const JULES_USAGE = `ai-os jules <cmd>   (Jules API, jules.googleapis.com/v1alpha; JULES_API_KEY, otherwise gcloud OAuth)
  run [prompt|-] [--repo o/r] [--branch b] [--no-pr] [--approve] [--wait] [--title t]
                       new session (prompt on stdin with -); --wait waits for the result (PR)
  sessions [--limit n] | show <id> | activities <id> | result <id>
  approve <id> | send <id> <message> | sources`;

export async function julesCli(argv: string[]): Promise<number> {
  const { values: o, positionals: p } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      branch: { type: "string" },
      title: { type: "string" },
      "no-pr": { type: "boolean" },
      approve: { type: "boolean" },
      wait: { type: "boolean" },
      limit: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = p;
  if (o.help || !cmd) {
    console.log(JULES_USAGE);
    return cmd || o.help ? 0 : 2;
  }
  const jules = await julesClient();
  switch (cmd) {
    case "run": {
      const prompt =
        rest[0] && rest[0] !== "-" ? rest.join(" ") : await readStdin();
      if (!prompt) return (console.error("ai-os jules run: prompt vide"), 2);
      const run = await jules.run({
        prompt,
        source: {
          github: o.repo ?? DEFAULT_REPO,
          baseBranch: o.branch ?? "main",
        },
        autoPr: !o["no-pr"],
        requireApproval: !!o.approve,
        ...(o.title ? { title: o.title } : {}),
      });
      if (!o.wait) return (print({ id: run.id }), 0);
      const out = await run.result();
      print({
        id: out.sessionId,
        title: out.title,
        state: out.state,
        pullRequest: out.pullRequest,
      });
      return out.state === "completed" ? 0 : 1;
    }
    case "sessions": {
      const list = [];
      for await (const s of jules.sessions({ limit: Number(o.limit ?? 20) }))
        list.push({
          id: s.id,
          title: s.title,
          state: s.state,
          url: s.url,
          updateTime: s.updateTime,
        });
      return (print(list), 0);
    }
    case "show":
      return (print(await jules.session(rest[0]!).info()), 0);
    case "result": {
      const out = await jules.session(rest[0]!).result();
      print({
        id: out.sessionId,
        title: out.title,
        state: out.state,
        pullRequest: out.pullRequest,
      });
      return out.state === "completed" ? 0 : 1;
    }
    case "activities": {
      const s = jules.session(rest[0]!);
      return (print(await s.activities.select({})), 0);
    }
    case "approve":
      await jules.session(rest[0]!).approve();
      return (print({ approved: rest[0] }), 0);
    case "send":
      await jules
        .session(rest[0]!)
        .send(rest.slice(1).join(" ") || (await readStdin()));
      return (print({ sent: rest[0] }), 0);
    case "sources": {
      const list = [];
      for await (const s of jules.sources()) list.push(s);
      return (print(list), 0);
    }
    default:
      console.error(JULES_USAGE);
      return 2;
  }
}

/** src Stitch client: API key if present, otherwise gcloud OAuth (same headers as the relay). */
export async function stitchClient() {
  const { StitchToolClient } = await import("./stitch/src/index.ts");
  if (Bun.env.STITCH_API_KEY) return new StitchToolClient({});
  const { gcloudCredentials } = await import("./auth.ts");
  const { token, project } = await gcloudCredentials();
  return new StitchToolClient({ accessToken: token, projectId: project });
}

const STITCH_USAGE = `ai-os stitch <cmd>   (Stitch MCP, stitch.googleapis.com/mcp)
  projects | create <title> | screens <projectId> | tools
  generate <projectId> <prompt> [--device DESKTOP|MOBILE|TABLET|AGNOSTIC]
  html <projectId> <screenId>          screen HTML (stdout)
  download <projectId> <dir>           screens + assets (HTML rewritten locally)
  upload <projectId> <file>            image (png/jpg/webp) or HTML -> new screen (BatchCreateScreens)
  design-md <projectId> <DESIGN.md>    uploads a DESIGN.md (google-labs-code/design.md format)
  design-layout <DESIGN.md> [w] [h]    resolves the Taffy layout from DESIGN.md (via ay design layout)
  skills-sync [--write]                synchronise stitch-skills + design.md vers .agents/skills
  call <tool> [json-args]              appel brut d'un outil`;

export async function stitchCli(argv: string[]): Promise<number> {
  const { values: o, positionals: p } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      device: { type: "string" },
      write: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, a, b, cArg] = p;
  if (o.help || !cmd) {
    console.log(STITCH_USAGE);
    return cmd || o.help ? 0 : 2;
  }
  if (cmd === "skills-sync") {
    const { mirror } = await import("./absorb.ts");
    const write = Boolean(o.write);
    const d = mirror(write);
    for (const x of d) console.log(`${x.kind}\t${x.skill}/${x.file}`);
    console.log(`${d.length} diff(s)${write ? " fixed" : ""}`);
    return !write && d.length ? 1 : 0;
  }
  if (cmd === "design-layout") {
    const file = a ?? "apps/web/DESIGN.md";
    const width = b ?? "1440";
    const height = cArg ?? "900";
    const r = Bun.spawnSync(["ay", "design", "layout", file, width, height], {
      stdout: "inherit",
      stderr: "inherit",
    });
    return r.exitCode;
  }
  const { Stitch } = await import("./stitch/src/index.ts");
  const c = await stitchClient();
  const s = new Stitch(c);
  try {
    switch (cmd) {
      case "projects":
        print(
          (await s.projects()).map((x: any) => ({
            id: x.projectId,
            title: x.data?.title,
          })),
        );
        break;
      case "create":
        print({ id: (await s.createProject(p.slice(1).join(" "))).projectId });
        break;
      case "screens":
        print(
          (await s.project(a!).screens()).map((x: any) => ({
            id: x.screenId,
            title: x.data?.title,
          })),
        );
        break;
      case "generate": {
        const gen = await s
          .project(a!)
          .generate(p.slice(2).join(" "), (o.device ?? "DESKTOP") as any);
        print(
          [...gen].map((x: any) => ({ id: x.screenId, title: x.data?.title })),
        );
        break;
      }
      case "html":
        process.stdout.write(
          await (await s.project(a!).getScreen(b!)).readHtml(),
        );
        break;
      case "download":
        print(await s.project(a!).downloadAssets(b!));
        break;
      case "upload":
        print(
          (await s.project(a!).upload(b!)).map((x: any) => ({
            id: x.screenId,
            title: x.data?.title,
          })),
        );
        break;
      case "design-md": {
        const bytes = await Bun.file(b!).bytes();
        print(
          await s
            .project(a!)
            .uploadDesignMd(Buffer.from(bytes).toString("base64")),
        );
        break;
      }
      case "tools":
        print((await c.listTools()).tools.map((t: any) => t.name));
        break;
      case "call":
        print(await c.callTool(a!, b ? JSON.parse(b) : {}));
        break;
      default:
        console.error(STITCH_USAGE);
        return 2;
    }
    return 0;
  } finally {
    await c.close();
  }
}

/** API error rendered as JSON on stderr (code, HTTP status), without stack. */
export async function guarded(run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (e: any) {
    console.error(
      JSON.stringify({
        error: e?.name ?? "Error",
        code: e?.code,
        status: e?.status,
        message: String(e?.message ?? e),
      }),
    );
    return 1;
  }
}

if (import.meta.main) {
  const [area, ...rest] = Bun.argv.slice(2);
  const code =
    area === "jules"
      ? await guarded(() => julesCli(rest))
      : area === "stitch"
        ? await guarded(() => stitchCli(rest))
        : (console.error("usage: cli.ts jules|stitch ..."), 2);
  process.exit(code);
}
