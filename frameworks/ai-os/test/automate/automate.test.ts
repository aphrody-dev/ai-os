// ai-os automate: CLI over @aphrody/automate (list, dry run, TUI frame) and the ai-router library download check.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODELES } from "@aphrody/automate";
import { frame, main, run } from "../../src/automate/cli.ts";
import { ensureNativeLibrary } from "../../src/automate/router.ts";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

test("dry run executes a template through the library without outside access", async () => {
  const seen: string[] = [];
  const r = await run(
    "facture-slack",
    { data: { data: { type: "facture", numero: "F-7" } } },
    { log: (s) => seen.push(s.trim()) },
  );
  expect(r.statut).toBe("succes");
  expect(r.etapes.map((e) => e.noeud)).toEqual([
    "declencheur",
    "facture",
    "slack",
  ]);
  expect(seen[0]).toMatch(/^\[dry\] POST https:\/\/dry-run\.invalid\//);
  await expect(run("nope", {})).rejects.toThrow(/unknown template/);
});

test("list prints every template, run reports the steps and the exit code", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    expect(await main(["list"])).toBe(0);
    expect(lines).toHaveLength(MODELES.length);
    lines.length = 0;
    expect(await main(["run", "veille-rss"])).toBeGreaterThanOrEqual(0);
    expect(lines.some((l) => l.startsWith("veille-rss:"))).toBe(true);
  } finally {
    console.log = log;
  }
  expect(await main(["bogus"])).toBe(2);
});

test("TUI frame: selection, detail pane and help line at a given size", () => {
  const f = frame(1, 100, 24);
  const plain = f.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  expect(plain).toContain("> paiement-merci");
  expect(plain).toContain(MODELES[1]!.nom);
  expect(plain).toContain("Enter dry run");
  expect(plain.split("\n")).toHaveLength(24);
});

test("ai-router native library: digest verified before install, mismatch refused", async () => {
  const d = mkdtempSync(join(tmpdir(), "airouter-"));
  temps.push(d);
  const saved = { home: Bun.env.AGENT_HOME, lib: Bun.env.AI_ROUTER_LIB };
  Bun.env.AGENT_HOME = d;
  delete Bun.env.AI_ROUTER_LIB;
  const bytes = new TextEncoder().encode("fake library");
  const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
  const platform = {
    win32: "windows-ai_router.dll",
    linux: "linux-libai_router.so",
    darwin: "macos-libai_router.dylib",
  }[process.platform as "win32"];
  const stub = (good: boolean) =>
    (async (url: string) =>
      String(url).includes("api.github.com")
        ? Response.json({
            assets: [
              {
                name: platform,
                digest: good ? digest : "sha256:00",
                browser_download_url: "https://x.invalid/lib",
              },
            ],
          })
        : new Response(bytes)) as unknown as typeof fetch;
  try {
    await expect(ensureNativeLibrary(stub(false))).rejects.toThrow(
      /digest mismatch/,
    );
    const p = await ensureNativeLibrary(stub(true));
    expect(readFileSync(p, "utf8")).toBe("fake library");
    expect(await ensureNativeLibrary(stub(false))).toBe(p); // installed: no second download
  } finally {
    saved.home === undefined
      ? delete Bun.env.AGENT_HOME
      : (Bun.env.AGENT_HOME = saved.home);
    saved.lib === undefined
      ? delete Bun.env.AI_ROUTER_LIB
      : (Bun.env.AI_ROUTER_LIB = saved.lib);
  }
});
