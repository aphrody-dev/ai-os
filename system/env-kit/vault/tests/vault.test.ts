// SPDX-License-Identifier: Apache-2.0
// Isolated vault (temp root, temp local store, temp hosts/policy): factice secrets only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "vault-test-"));
process.env.APHRODY_VAULT_DIR = root;
process.env.ENV_KIT_SECRET_DIR = join(root, "local");
process.env.VAULT_HOSTS_FILE = join(root, "hosts.toml");
process.env.VAULT_POLICY_FILE = join(root, "policy.toml");
process.env.VAULT_HELLO = "0";
const infra = join(import.meta.dir, "..", "..", "..", "..", "device", "vault");
copyFileSync(join(infra, "hosts.toml"), process.env.VAULT_HOSTS_FILE);
copyFileSync(join(infra, "policy.toml"), process.env.VAULT_POLICY_FILE);

const V = await import("../src/index.ts");
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const FACTICE = `factice-${crypto.randomUUID()}`;
const linuxNoCreds =
  process.platform === "linux" &&
  Bun.spawnSync(["systemd-creds", "--user", "has-tpm2"]).exitCode === null;

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(linuxNoCreds)("local layer", () => {
  test("set / get / has / list / delete, no value on disk in clear", async () => {
    await V.setSecret("VAULT_TEST_TOKEN", FACTICE);
    expect(await V.getSecret("VAULT_TEST_TOKEN")).toBe(FACTICE);
    expect(await V.hasSecret("VAULT_TEST_TOKEN")).toBe(true);
    expect(await V.listSecrets()).toContain("VAULT_TEST_TOKEN");
    const file = join(
      root,
      "local",
      process.platform === "win32"
        ? "VAULT_TEST_TOKEN.dpapi"
        : "VAULT_TEST_TOKEN",
    );
    expect(readFileSync(file).includes(Buffer.from(FACTICE))).toBe(false);
    expect(await V.deleteSecret("VAULT_TEST_TOKEN")).toBe(true);
    expect(await V.getSecret("VAULT_TEST_TOKEN")).toBeUndefined();
  });

  test("rejects bad names and empty values", async () => {
    await expect(V.setSecret("../evil", "x")).rejects.toThrow();
    await expect(V.setSecret("VAULT_EMPTY", "")).rejects.toThrow();
  });

  test("runWithSecrets passes the value through the child env only", async () => {
    await V.setSecret("VAULT_TEST_ENV", FACTICE);
    const out = join(root, "child.txt");
    const r = await V.runWithSecrets(
      ["VAULT_TEST_ENV"],
      [
        process.execPath,
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(out)}, String(process.env.VAULT_TEST_ENV.length))`,
      ],
    );
    expect(r.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(String(FACTICE.length));
  });

  test("event loop stays responsive during 64 concurrent DPAPI round trips", async () => {
    let ticks = 0;
    const t = setInterval(() => ticks++, 1);
    const data = crypto.getRandomValues(new Uint8Array(4096));
    await Promise.all(
      Array.from({ length: 64 }, (_, i) =>
        V.setSecret(`VAULT_LOAD_${i}`, data),
      ),
    );
    const back = await Promise.all(
      Array.from({ length: 64 }, (_, i) => V.getSecretBytes(`VAULT_LOAD_${i}`)),
    );
    clearInterval(t);
    expect(
      back.every((b) => b && Buffer.from(b).equals(Buffer.from(data))),
    ).toBe(true);
    expect(ticks).toBeGreaterThan(0);
    await Promise.all(
      Array.from({ length: 64 }, (_, i) => V.deleteSecret(`VAULT_LOAD_${i}`)),
    );
  });
});

describe.skipIf(process.platform !== "win32")("DPAPI format v2", () => {
  test("writes v2 bound to the name, reads v1, renamed blob refused, env-kit interop", async () => {
    const dpapiProtect = V.dpapiProtectRaw;
    const dir = join(root, "local");
    await V.setSecret("VAULT_V2_A", FACTICE);
    const a = readFileSync(join(dir, "VAULT_V2_A.dpapi"));
    expect(a.subarray(0, 4).toString()).toBe("AYD2");
    // v1 blob as env-kit wrote it before v2: still read.
    writeFileSync(
      join(dir, "VAULT_V1_B.dpapi"),
      await dpapiProtect(new TextEncoder().encode(FACTICE)),
    );
    expect(await V.getSecret("VAULT_V1_B")).toBe(FACTICE);
    // Renaming a v2 blob to another secret: DPAPI refuses (entropy carries the name).
    copyFileSync(join(dir, "VAULT_V2_A.dpapi"), join(dir, "VAULT_V2_C.dpapi"));
    expect(
      await V.getSecret("VAULT_V2_C").then(
        () => "opened",
        (e: Error) => e.message,
      ),
    ).toBe("CryptUnprotectData failed");
    // env-kit (sync API) reads both and writes v2.
    const ek = await import("../src/sync-store.ts");
    expect(ek.secretGet("VAULT_V2_A")).toBe(FACTICE);
    expect(ek.secretGet("VAULT_V1_B")).toBe(FACTICE);
    ek.secretSet("VAULT_V1_B", FACTICE);
    expect(
      readFileSync(join(dir, "VAULT_V1_B.dpapi")).subarray(0, 4).toString(),
    ).toBe("AYD2");
    expect(await V.getSecret("VAULT_V1_B")).toBe(FACTICE);
    // v1 read migrates lazily; migrate-dpapi then sets the marker and v1 is refused by vault and env-kit.
    writeFileSync(
      join(dir, "VAULT_V1_D.dpapi"),
      await dpapiProtect(new TextEncoder().encode(FACTICE)),
    );
    expect(await V.getSecret("VAULT_V1_D")).toBe(FACTICE);
    expect(
      readFileSync(join(dir, "VAULT_V1_D.dpapi")).subarray(0, 4).toString(),
    ).toBe("AYD2");
    writeFileSync(
      join(dir, "VAULT_V1_E.dpapi"),
      await dpapiProtect(new TextEncoder().encode(FACTICE)),
    );
    rmSync(join(dir, "VAULT_V2_C.dpapi"));
    const m = await V.migrateDpapiV2();
    expect(m).toMatchObject({ migrated: 1, marker: true });
    writeFileSync(
      join(dir, "VAULT_V1_F.dpapi"),
      await dpapiProtect(new TextEncoder().encode(FACTICE)),
    );
    expect(
      await V.getSecret("VAULT_V1_F").then(
        () => "opened",
        (e: Error) => e.message,
      ),
    ).toContain("v1 refused");
    expect(() => ek.secretGet("VAULT_V1_F")).toThrow("v1 refused");
    rmSync(join(dir, "VAULT_V1_F.dpapi"));
    rmSync(V.v2OnlyMarker());
  });
});

describe.skipIf(linuxNoCreds)("envelopes and documents", () => {
  test("AYV1 seal/open, AAD bound", async () => {
    const env = await V.seal("doc|json|x", new TextEncoder().encode(FACTICE));
    expect(V.isSealed(env)).toBe(true);
    expect(new TextDecoder().decode(await V.open("doc|json|x", env))).toBe(
      FACTICE,
    );
    await expect(V.open("doc|json|y", env)).rejects.toThrow();
  });

  test("json / toml / csv / xml documents round trip", async () => {
    await V.writeDocument("t-json", "json", { a: FACTICE, n: 1 });
    await V.writeDocument("t-toml", "toml", `k = "${FACTICE}"\n`);
    await V.writeDocument("t-csv", "csv", [
      ["a", "b"],
      [FACTICE, 'q"uote,comma'],
    ]);
    await V.writeDocument("t-xml", "xml", `<k>${FACTICE}</k>`);
    expect(await V.readDocument("t-json", "json")).toEqual({
      a: FACTICE,
      n: 1,
    });
    expect(await V.readDocument("t-toml", "toml")).toEqual({ k: FACTICE });
    expect(await V.readDocument("t-csv", "csv")).toEqual([
      ["a", "b"],
      [FACTICE, 'q"uote,comma'],
    ]);
    expect(await V.readDocument("t-xml", "xml")).toBe(`<k>${FACTICE}</k>`);
    const raw = readFileSync(join(root, "docs", "t-json.json.ayv"));
    expect(raw.includes(Buffer.from(FACTICE))).toBe(false);
    expect((await V.listDocuments()).length).toBe(4);
  });

  test("row-encrypted sqlite with blinded keys", async () => {
    const t = new V.EncryptedTable(join(root, "kv.sqlite"), "kv", {
      blindKeys: true,
    });
    await t.put("api", { token: FACTICE });
    expect(await t.getJson("api")).toEqual({ token: FACTICE });
    expect(t.count()).toBe(1);
    expect(await t.delete("api")).toBe(true);
    t.close();
    expect(
      readFileSync(join(root, "kv.sqlite")).includes(Buffer.from(FACTICE)),
    ).toBe(false);
  });
});

describe.skipIf(linuxNoCreds)("chromium password csv", () => {
  test("import (aliases), seal, shred, export in writer format", async () => {
    const src = join(root, "Chrome Passwords.csv");
    writeFileSync(
      src,
      `name,url,username,password,notes\nex,https://example.test/,alice,${FACTICE},"a, b"\n`,
    );
    const r = await V.importChromeCsv(src);
    expect(r).toMatchObject({ imported: 1, total: 1 });
    expect(existsSync(src)).toBe(false);
    const out = join(root, "export.csv");
    expect((await V.exportChromeCsv(out)).rows).toBe(1);
    const text = readFileSync(out, "utf8");
    expect(text.split("\n")[0]).toBe("name,url,username,password,note");
    expect(V.rowsFromCsv(text)[0]).toEqual({
      name: "ex",
      url: "https://example.test/",
      username: "alice",
      password: FACTICE,
      note: "a, b",
    });
    await V.shred(out);
  });

  test("csv parser handles quotes, CRLF, embedded newlines, BOM", () => {
    expect(V.parseCsv('\uFEFFa,"b\r\nc","d""e"\r\nf,g,h')).toEqual([
      ["a", "b\r\nc", 'd"e'],
      ["f", "g", "h"],
    ]);
  });
});

describe("scope", () => {
  test("defaults stay on the PC, reserved and PC-only kinds never leave", async () => {
    const policy = await V.loadPolicy();
    expect(V.scopeOf("ANY_TOKEN", "token", policy, {})).toEqual(["pc"]);
    expect(V.scopeOf("VAULT_PROOF_TOKEN", "token", policy, {})).toEqual([
      "pc",
      "prd",
      "fr2",
    ]);
    expect(
      V.scopeOf("VAULT_MASTER_KEY", "token", policy, {
        VAULT_MASTER_KEY: { kind: "token", scope: ["prd"], updated: "" },
      }),
    ).toEqual([]);
    expect(
      V.scopeOf("x", "chrome-passwords", policy, {
        x: { kind: "chrome-passwords", scope: ["pc", "prd"], updated: "" },
      }),
    ).toEqual(["pc"]);
  });

  test("owner profile refused", () => {
    expect(
      V.isOwnerProfile("C:/Users/x/AppData/Local/Google/Chrome/User Data"),
    ).toBe(true);
    expect(
      V.isOwnerProfile("C:/Users/x/AppData/Local/aphrody/relay/chrome"),
    ).toBe(false);
  });
});

describe.skipIf(!Bun.which("age") || linuxNoCreds)("age per host", () => {
  test("seal outbox only for hosts in scope, idempotent, decryptable by the host identity", async () => {
    const pc = await V.ageKeygen();
    const prd = await V.ageKeygen();
    const fr1 = await V.ageKeygen();
    await V.setRecipient("pc", pc.recipient);
    await V.setRecipient("prd", prd.recipient);
    await V.setRecipient("fr1", fr1.recipient);
    await V.setSecret("VAULT_PROOF_TOKEN", FACTICE);
    await V.setSecret("PC_ONLY_TOKEN", FACTICE);
    const a = await V.sealOutbox();
    expect(a.find((r) => r.host === "prd")).toMatchObject({
      sealed: 1,
      total: 1,
    });
    expect(a.find((r) => r.host === "fr1")).toMatchObject({
      sealed: 0,
      total: 0,
    });
    const b = await V.sealOutbox();
    expect(b.find((r) => r.host === "prd")).toMatchObject({
      sealed: 0,
      unchanged: 1,
    });
    const env = join(root, "outbox", "prd", "VAULT_PROOF_TOKEN.age");
    expect(
      new TextDecoder().decode(await V.ageDecryptFile(env, prd.identity)),
    ).toBe(FACTICE);
    await expect(V.ageDecryptFile(env, fr1.identity)).rejects.toThrow();
    expect(existsSync(join(root, "outbox", "prd", "PC_ONLY_TOKEN.age"))).toBe(
      false,
    );
    expect(V.taskXml("PC\\u", 5, CLI)).toContain(
      "<StateChange>SessionUnlock</StateChange>",
    );
    const syncXml = V.taskXml("PC\\u", 5, CLI);
    expect(syncXml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(syncXml).toContain("<LogonTrigger>");
    const pushXml = V.taskXml(
      "PC\\u",
      15,
      CLI,
      "push",
    );
    expect(pushXml).toContain("<LogonType>S4U</LogonType>");
    expect(pushXml).toContain("sync --push-only");
    expect(pushXml).not.toContain("SessionStateChangeTrigger");
    expect(pushXml).not.toContain("conhost");
  });
});

describe("host removal", () => {
  test("forgetHost drops the table, its scopes in policy and registry", async () => {
    await V.register("SCOPED_X", "token", ["pc", "fr1", "fr2"]);
    const r = await V.forgetHost("fr2");
    expect(r.registryScopes).toBe(1);
    expect(r.policyScopes).toBeGreaterThan(0);
    expect((await V.loadHosts()).map((h) => h.name)).not.toContain("fr2");
    expect((await V.loadRegistry()).SCOPED_X!.scope).toEqual(["pc", "fr1"]);
    expect(
      V.scopeOf("VAULT_PROOF_TOKEN", "token", await V.loadPolicy(), {}),
    ).toEqual(["pc", "prd"]);
    const hostsText = readFileSync(process.env.VAULT_HOSTS_FILE!, "utf8");
    expect(hostsText).toContain("[fr1]");
    // The comment block above [fr1] belongs to fr1 and survives the removal of [fr2].
    expect(hostsText).toContain("# fr1 (Chromium/LLVM builds only)");
    expect(hostsText).not.toContain("# fr2 (proxy");
    expect(process.env.VAULT_POLICY_FILE!.startsWith(root)).toBe(true);
    expect(
      await V.forgetHost("pc").then(
        () => "ok",
        (e: Error) => e.message,
      ),
    ).toBe("the PC cannot be removed");
    expect(
      await V.removeHost("pc").then(
        () => "ok",
        (e: Error) => e.message,
      ),
    ).toBe("the PC cannot be removed");
    expect(
      await V.forgetHost("nope").then(
        () => "ok",
        (e: Error) => e.message,
      ),
    ).toContain("absent");
  });
});

describe.skipIf(process.platform !== "win32")("Windows Hello", () => {
  test("status is silent (no UI)", async () => {
    const s = await V.helloStatus(await V.HELLO_KEY());
    expect(typeof s.provider).toBe("boolean");
  });
});
