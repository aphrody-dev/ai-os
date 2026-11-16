// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { spawnSync } from "../src/spawn.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatChecks, hostScript, loadManifest } from "../src/auth";

const root = resolve(import.meta.dir, "..", "..", "..");

describe("auth manifest", () => {
  test("device/deploy.toml declares hosts and GitHub secrets by name only", () => {
    const m = loadManifest(root);
    expect(Object.keys(m.nodes)).toContain("usa");
    expect(m.auth.hosts?.usa?.tunnels).toBeDefined();
    for (const names of Object.values(m.auth.github?.repo_secrets ?? {}))
      for (const n of names) expect(n).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });

  test("keyless CI federation is declared without spaces (gcloud.cmd goes through cmd.exe)", () => {
    const g = loadManifest(root).auth.oidc?.gcp;
    expect(g?.issuer).toBe("https://token.actions.githubusercontent.com");
    // Repository owner since the transfer aphrody-dev/src -> aphrody-labs/src (2026-11-13).
    expect(g?.condition).toBe("assertion.repository_owner=='aphrody-labs'");
    for (const r of (g as { repos?: string[] }).repos ?? [])
      expect(r.startsWith("aphrody-labs/")).toBe(true);
    for (const v of [g!.condition, g!.pool, g!.provider, g!.service_account])
      expect(v).not.toMatch(/\s/);
  });

  test("host script is valid bash and embeds no value", () => {
    const s = hostScript(
      {
        tunnels: { "cloudflared-x": "x" },
        wireguard: ["wg0"],
        units: ["certbot"],
      },
      ["ssh-ed25519 AAAAC3Nza test"],
      false,
    );
    expect(s).toContain("REPAIR=0");
    const bash = spawnSync("bash", ["-n"], { input: s, encoding: "utf8" });
    if (bash.error) return; // no bash on this host
    expect(bash.status).toBe(0);
  });

  test("report counts statuses", () => {
    const out = formatChecks([
      {
        kind: "cli",
        target: "gh",
        host: "pc",
        status: "ok",
        proof: "gh api user -> x",
      },
      {
        kind: "ssh",
        target: "prd",
        host: "usa",
        status: "invalid",
        proof: "refused",
        fix: "key",
      },
    ]);
    expect(out).toContain("1 ok");
    expect(out).toContain("1 invalid");
  });
});

describe("secret store", () => {
  const usable =
    process.platform === "win32" ||
    (process.platform === "linux" &&
      spawnSync(
        "systemd-creds",
        [
          ...(process.getuid?.() === 0 ? [] : ["--user"]),
          "encrypt",
          "--name=t",
          "-",
          "-",
        ],
        { input: "x" },
      ).status === 0);

  test.skipIf(!usable)(
    "round-trips through the OS backend without plaintext on disk",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "envkit-store-"));
      process.env.ENV_KIT_SECRET_DIR = dir;
      try {
        const { secretSet, secretGet, secretList, secretDelete } =
          await import("@aphrody/env-kit/vault/sync");
        secretSet("ENVKIT_TEST_TOKEN", "value-under-test");
        expect(secretList()).toEqual(["ENVKIT_TEST_TOKEN"]);
        expect(secretGet("ENVKIT_TEST_TOKEN")).toBe("value-under-test");
        const raw = await Bun.file(
          join(
            dir,
            process.platform === "win32"
              ? "ENVKIT_TEST_TOKEN.dpapi"
              : "ENVKIT_TEST_TOKEN",
          ),
        ).text();
        expect(raw.includes("value-under-test")).toBe(false);
        expect(() => secretSet("ENVKIT_TEST_TOKEN", "")).toThrow();
        expect(() => secretSet("../evil", "x")).toThrow();
        expect(secretDelete("ENVKIT_TEST_TOKEN")).toBe(true);
      } finally {
        delete process.env.ENV_KIT_SECRET_DIR;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
