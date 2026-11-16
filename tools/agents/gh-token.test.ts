import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (args: string[], home: string, stdin = "") =>
  Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "gh-token.ts"), ...args],
    {
      stdin: Buffer.from(stdin),
      stdout: "pipe",
      // the vault (APHRODY_VAULT_DIR, ENV_KIT_SECRET_DIR) and every home-relative dir point at the temp dir: no real secret is reachable
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: home,
        APPDATA: home,
        XDG_DATA_HOME: home,
        XDG_STATE_HOME: home,
        XDG_CONFIG_HOME: home,
        APHRODY_VAULT_DIR: home,
        ENV_KIT_SECRET_DIR: home,
        AGENTS_HOME: home,
      },
    },
  );

test("valid cache served to the git protocol, other hosts and operations ignored", () => {
  const home = mkdtempSync(join(tmpdir(), "ghtok-"));
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(
    join(home, "state", "gh-token.json"),
    JSON.stringify({
      token: "ghs_test",
      expires_at: new Date(Date.now() + 3_000_000).toISOString(),
    }),
  );
  expect(
    run(
      ["git", "get"],
      home,
      "protocol=https\nhost=github.com\n\n",
    ).stdout.toString(),
  ).toBe("username=x-access-token\npassword=ghs_test\n");
  expect(
    run(
      ["git", "get"],
      home,
      "protocol=https\nhost=gitlab.com\n\n",
    ).stdout.toString(),
  ).toBe("");
  expect(
    run(["git", "store"], home, "host=github.com\n").stdout.toString(),
  ).toBe("");
  expect(run([], home).stdout.toString()).toBe("ghs_test");
});

test("cache close to expiry and no key: no token", () => {
  const home = mkdtempSync(join(tmpdir(), "ghtok-"));
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(
    join(home, "state", "gh-token.json"),
    JSON.stringify({
      token: "old",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  const r = run([], home);
  // boolean assertions: a failing toBe would print the received token
  expect(r.stdout.toString() === "").toBe(true);
  expect(r.exitCode).toBe(1);
});
