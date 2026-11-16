// SPDX-License-Identifier: Apache-2.0
// Regression (prd, 2026-11-13): a root *user* service under ProtectSystem=strict (aphrody-relay) could
// not create the master key, /etc/credstore.encrypted being read-only. Reproduced here as a transient
// system unit: root, ProtectSystem=strict, only a temp HOME/.local/state writable, no user manager, no
// D-Bus session (transient units get the manager's clean environment). Runs on Linux as root only.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const rootLinux =
  process.platform === "linux" &&
  process.getuid?.() === 0 &&
  !!Bun.which("systemd-run");

describe.skipIf(!rootLinux)("Linux root, sandboxed, no user session", () => {
  test("master key, sealed document and secret round trip under ProtectSystem=strict", async () => {
    // Outside /tmp: PrivateTmp hides the host /tmp from the unit.
    const home = mkdtempSync(join(homedir(), ".vault-sbx-"));
    const script = `
      const V = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "index.ts"))});
      const env = await V.seal("doc|json|sbx", new TextEncoder().encode("factice"));
      const back = new TextDecoder().decode(await V.open("doc|json|sbx", env));
      await V.writeDocument("sbx", "json", { factice: true });
      const doc = await V.readDocument("sbx", "json");
      await V.setSecret("VAULT_SBX_TOKEN", "factice");
      const tok = await V.getSecret("VAULT_SBX_TOKEN");
      console.log(JSON.stringify({ back, doc, tok, root: V.vaultRoot(), store: V.localStore().dir }));
    `;
    Bun.spawnSync(["mkdir", "-p", `${home}/.local/state`]);
    const p = Bun.spawn(
      [
        "systemd-run",
        "--quiet",
        "--wait",
        "--pipe",
        "--collect",
        "-p",
        "ProtectSystem=strict",
        "-p",
        `ReadWritePaths=${home}/.local/state`,
        "-p",
        "PrivateTmp=true",
        "-p",
        "NoNewPrivileges=true",
        // A transient system unit starts from the manager's clean environment: no session bus, no runtime dir.
        "-E",
        `HOME=${home}`,
        process.execPath,
        "-e",
        script,
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home } },
    );
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    rmSync(home, { recursive: true, force: true });
    expect({ code, err: code ? err.slice(-400) : "" }).toEqual({
      code: 0,
      err: "",
    });
    const r = JSON.parse(out.trim().split("\n").pop()!);
    expect(r).toMatchObject({
      back: "factice",
      doc: { factice: true },
      tok: "factice",
    });
    // /etc/credstore.encrypted is read-only in the unit: the store falls back under the vault root.
    expect(r.root.startsWith(`${home}/.local/`)).toBe(true);
    expect(r.store).toBe(`${r.root}/local`);
  }, 60_000);
});
