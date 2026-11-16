// `ai-os automate`: front end of @aphrody/automate (the automation engine extracted from apps/auto) for the terminal.
//   ai-os automate list [--json]                         templates of the library
//   ai-os automate run <template> [--input '<json>'] [--live]   run one; dry run by default (no network, no mail)
//   ai-os automate models [auto|auto:local|auto:free|auto:cheap] [--json]   offers of the ai-router library (aphrody-labs/open)
//   ai-os automate tui                                   full-screen browser of the templates (arrows, Enter runs, q quits)
// The same library serves apps/auto (API and web), apps/web (automations page), the CLI and the TUI.
import {
  type Element,
  executer,
  MODELES,
  type Modele,
  type Resultat,
  type Services,
  valider,
} from "@aphrody/automate";

const find = (id: string): Modele => {
  const m = MODELES.find((x) => x.id === id);
  if (!m)
    throw new Error(
      `unknown template: ${id} (known: ${MODELES.map((x) => x.id).join(", ")})`,
    );
  return m;
};

/** Services of a dry run: every outside access is recorded and answered with an empty success. */
export function dryServices(log: (s: string) => void = () => {}): Services {
  return {
    async fetch(url, init) {
      log(`  [dry] ${init.method ?? "GET"} ${url}`);
      return Response.json({ ok: true });
    },
    async envoyerMail(m) {
      log(`  [dry] mail to ${m.a}: ${m.sujet}`);
    },
    async appelerAuto(methode: string, chemin: string) {
      log(`  [dry] ${methode} ${chemin}`);
      return { statut: 200, corps: [] };
    },
  } as Services;
}

/** Secrets that always resolve (dry run): a reserved, unroutable address per name. */
const drySecrets = new Proxy({} as Record<string, string>, {
  get: (_t, k) =>
    typeof k === "string" ? `https://dry-run.invalid/${k}` : undefined,
});

export async function run(
  id: string,
  input: unknown,
  o: { live?: boolean; log?: (s: string) => void } = {},
): Promise<Resultat> {
  const m = find(id);
  const items: Element[] = [{ json: (input ?? {}) as Record<string, unknown> }];
  return executer(valider(m.definition), items, {
    services: o.live
      ? ({ fetch: (u: string, i: RequestInit) => fetch(u, i) } as Services)
      : dryServices(o.log),
    workflow: { id: m.id, nom: m.nom },
    executionId: `cli-${Date.now()}`,
    secrets: o.live ? {} : drySecrets,
  });
}

const line = (m: Modele) =>
  `${m.id.padEnd(20)} ${String(m.definition.noeuds.length).padStart(2)} nodes  ${m.nom}`;

function report(id: string, r: Resultat) {
  console.log(
    `${id}: ${r.statut}${r.erreur ? ` at ${r.erreur.noeud}: ${r.erreur.message}` : ""}`,
  );
  for (const e of r.etapes)
    console.log(
      `  ${e.noeud.padEnd(14)} ${e.type.padEnd(26)} ${String(e.dureeMs).padStart(4)} ms  out ${e.sorties.join("/")}`,
    );
}

// ---- TUI -------------------------------------------------------------------------------------------------------

const ESC = "\x1b[";
const bold = (s: string) => `${ESC}1m${s}${ESC}22m`;
const dim = (s: string) => `${ESC}2m${s}${ESC}22m`;
const inv = (s: string) => `${ESC}7m${s}${ESC}27m`;

/** One frame of the TUI (pure: width, height, selection, last run result). */
export function frame(
  sel: number,
  w: number,
  h: number,
  result?: string[],
): string {
  const left = Math.min(34, Math.floor(w / 2));
  const rows: string[] = [];
  const m = MODELES[sel]!;
  const detail = [
    bold(m.nom),
    "",
    ...(
      m.description.match(
        new RegExp(`.{1,${Math.max(20, w - left - 4)}}(\\s|$)`, "g"),
      ) ?? [m.description]
    ).map((s) => s.trim()),
    "",
    dim(`id ${m.id}`),
    dim(
      `nodes ${m.definition.noeuds.length}, links ${m.definition.connexions.length}`,
    ),
    dim(`categories ${m.categories.join(", ")}`),
    "",
    ...(result ?? [dim("Enter: dry run this automation")]),
  ];
  for (let i = 0; i < h - 3; i++) {
    const t = MODELES[i];
    const l = t
      ? `${i === sel ? ">" : " "} ${t.id}`.slice(0, left - 1).padEnd(left - 1)
      : " ".repeat(left - 1);
    rows.push(`${i === sel ? inv(l) : l}│ ${detail[i] ?? ""}`);
  }
  return [
    bold(
      ` Automations  ${dim(`${MODELES.length} templates, @aphrody/automate`)}`,
    ),
    "─".repeat(left - 1) + "┬" + "─".repeat(Math.max(0, w - left)),
    ...rows,
    dim(" ↑↓ select   Enter dry run   q quit"),
  ].join("\n");
}

async function tui() {
  const out = process.stdout;
  const w = () => out.columns ?? 100;
  const h = () => out.rows ?? 30;
  let sel = 0;
  let result: string[] | undefined;
  const draw = () =>
    out.write(`${ESC}H${ESC}2J${frame(sel, w(), h(), result)}`);
  out.write(`\x1b]0;Automations TUI\x07${ESC}?1049h${ESC}?25l`);
  const done = () => out.write(`${ESC}?25h${ESC}?1049l`);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  draw();
  await new Promise<void>((resolve) => {
    process.stdin.on("data", async (b) => {
      const k = b.toString();
      if (k === "q" || k === "\x03") return resolve();
      if (k === `${ESC}A` || k === "k")
        sel = (sel + MODELES.length - 1) % MODELES.length;
      else if (k === `${ESC}B` || k === "j") sel = (sel + 1) % MODELES.length;
      else if (k === "\r") {
        const lines: string[] = [];
        const r = await run(
          MODELES[sel]!.id,
          {},
          { log: (s) => lines.push(s.trim()) },
        );
        result = [
          bold(`dry run: ${r.statut}`),
          ...r.etapes.map((e) => `${e.noeud} → ${e.sorties.join("/")}`),
          ...lines.slice(0, 3).map(dim),
        ];
      }
      if (k !== "\r") result = undefined;
      draw();
    });
  });
  done();
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = (f: string) => rest.includes(f);
  const opt = (f: string) =>
    rest.includes(f) ? rest[rest.indexOf(f) + 1] : undefined;
  switch (cmd) {
    case "list": {
      if (flag("--json"))
        console.log(
          JSON.stringify(
            MODELES.map((m) => ({
              id: m.id,
              name: m.nom,
              description: m.description,
              categories: m.categories,
              nodes: m.definition.noeuds.length,
            })),
            null,
            2,
          ),
        );
      else for (const m of MODELES) console.log(line(m));
      return 0;
    }
    case "run": {
      const id = rest.find((a) => !a.startsWith("--") && a !== opt("--input"));
      if (!id)
        throw new Error(
          "usage: ai-os automate run <template> [--input '<json>'] [--live]",
        );
      const r = await run(
        id,
        opt("--input") ? JSON.parse(opt("--input")!) : {},
        {
          live: flag("--live"),
          log: (s) => console.log(s),
        },
      );
      report(id, r);
      return r.statut === "succes" ? 0 : 1;
    }
    case "models": {
      // The offers an automation's AI node would be routed to: ai-router (open's library), local first, then free, then cheapest.
      const { offers } = await import("./router");
      const policy = rest.find((a) => !a.startsWith("--")) ?? "auto";
      const list = await offers(policy);
      if (flag("--json")) console.log(JSON.stringify(list, null, 2));
      else
        for (const o of list.slice(0, Number(opt("--limit") ?? 15)))
          console.log(
            `${(o.local ? "local" : "cloud").padEnd(5)} ${o.provider.padEnd(18)} ${o.model.padEnd(36)} in ${String(o.cost_in).padStart(6)} out ${String(o.cost_out).padStart(6)}  ctx ${o.context}`,
          );
      console.log(`${list.length} offers for policy ${policy}`);
      return list.length ? 0 : 1;
    }
    case "tui":
      await tui();
      return 0;
    default:
      console.error(
        "usage: ai-os automate list [--json] | run <template> [--input '<json>'] [--live] | models [policy] | tui",
      );
      return cmd ? 2 : 0;
  }
}

if (
  import.meta.main ||
  Bun.argv[1]?.replace(/\\/g, "/").endsWith("/src/cli.ts")
) {
  process.exitCode = await main(Bun.argv.slice(2));
}
