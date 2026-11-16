#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * `env-kit vault …` / `ay vault …`. Output: names, counts, lengths,
 * fingerprints. Never a value: values enter on stdin and leave through a child's env or stdin.
 */

import { exportChromeCsv, importChromeCsv } from "./chrome.ts";
import {
  b3,
  helloAvailable,
  HELLO_KEY,
  masterKey,
  RESERVED,
} from "./crypto.ts";
import {
  deleteDocument,
  documentInfo,
  FORMATS,
  listDocuments,
  readDocument,
  type DocFormat,
  encodeDoc,
  writeDocument,
} from "./doc.ts";
import {
  KINDS,
  type Kind,
  loadHosts,
  loadPolicy,
  loadRegistry,
  register,
  scopeOf,
} from "./hosts.ts";
import { migrateLegacy } from "./migrate.ts";
import { localStore, vaultRoot, WIN } from "./paths.ts";
import { backup, restore } from "./profiles.ts";
import { shred } from "./shred.ts";
import { listSecrets, setSecret } from "./store.ts";
import {
  initHost,
  initPc,
  installHost,
  pushOnly,
  removeHost,
  installTask,
  localFingerprint,
  remoteFingerprint,
  remoteStatus,
  rotateHost,
  sealOutbox,
  sync,
} from "./sync.ts";
import { helloEnroll, helloStatus } from "./win/pool.ts";

const USAGE = `env-kit vault <command>
  init                         master key + PC age identity (DPAPI), migrates the old env-kit store
  add NAME [--scope h,..] [--kind token|document]   value on stdin; scope = hosts that receive it
  import-chrome-csv FILE [--keep]   seal a Chromium password export, then shred FILE
  export-chrome-csv OUT        write name,url,username,password,note for a Chromium import
  doc put NAME FORMAT [--hello] (stdin) | doc pipe NAME FORMAT -- cmd | doc list | doc rm NAME FORMAT
  sync [--force] [--host h,..] [--push-only] [--install-task [MIN]]   seal + push age envelopes;
                               --push-only ships sealed envelopes without DPAPI (S4U task)
  status [--remote] [--json]   counts per kind, scope, outbox, last push (no value)
  rotate HOST | --master       new host identity (resealed, pushed) or new master key (docs resealed)
  hosts [list | init H | install H | remove H [--force]]   identity, apply timer, recipient (hosts.toml);
                               remove: revoke on the host, purge outbox, drop it from hosts/policy/registry
  fp NAME [--host H]           BLAKE3 of a secret, local or on a host (proof without the value)
  backup [NAME..] | restore NAME [DEST]   agent Chromium profiles and user data (profiles.toml)
  hello status | hello enroll  Windows Hello key (Passport KSP) for documents (--hello)
  migrate-dpapi                rewrite every DPAPI v1 blob as v2 (name-bound), then refuse v1
  shred FILE                   overwrite, flush, rename, unlink`;

const flag = (a: string[], f: string) => a.includes(f);
const opt = (a: string[], f: string) => {
  const i = a.indexOf(f);
  return i >= 0 ? a[i + 1] : undefined;
};
const list = (s?: string) =>
  s
    ? s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : undefined;
const say = (o: unknown, json: boolean) =>
  console.log(
    json
      ? JSON.stringify(o)
      : typeof o === "string"
        ? o
        : Bun.inspect(o, { colors: false, depth: 4 }),
  );

async function stdinBytes(trimNewline = true): Promise<Uint8Array | undefined> {
  if (process.stdin.isTTY) {
    console.error(
      "vault: pipe the value on stdin (clipboard, provider CLI), never type it",
    );
    return undefined;
  }
  let b = await Bun.stdin.bytes();
  // One trailing newline from `echo`/clipboard tools is not part of the secret.
  if (trimNewline && b.at(-1) === 0x0a)
    b = b.subarray(0, b.at(-2) === 0x0d ? -2 : -1);
  return b.byteLength ? b : undefined;
}

async function status(remote: boolean, json: boolean) {
  const [names, docs, hosts, policy, registry] = await Promise.all([
    listSecrets(),
    listDocuments(),
    loadHosts(),
    loadPolicy(),
    loadRegistry(),
  ]);
  const kinds: Record<string, number> = {};
  const scoped: Record<string, number> = {};
  for (const n of names) {
    const k = (registry[n]?.kind ?? "token") as Kind;
    kinds[k] = (kinds[k] ?? 0) + 1;
    if (RESERVED.has(n)) continue;
    for (const h of scopeOf(n, k, policy, registry))
      if (h !== "pc") scoped[h] = (scoped[h] ?? 0) + 1;
  }
  const last = await Bun.file(`${vaultRoot()}/state/last-sync.json`)
    .json()
    .catch(() => undefined);
  const out: Record<string, unknown> = {
    root: vaultRoot(),
    local: localStore().backend,
    secrets: names.length,
    kinds,
    documents: docs.map((d) => `${d.name}.${d.format}`),
    hello: WIN ? await helloAvailable() : false,
    hosts: Object.fromEntries(
      hosts.map((h) => [
        h.name,
        {
          recipient: h.recipient ? `${h.recipient.slice(0, 12)}…` : "-",
          scoped: scoped[h.name] ?? 0,
        },
      ]),
    ),
    lastSync: last?.at ?? "never",
  };
  if (remote) {
    out.remote = Object.fromEntries(
      await Promise.all(
        hosts
          .filter((h) => h.name !== "pc" && h.recipient)
          .map(async (h) => [h.name, await remoteStatus(h.name)]),
      ),
    );
  }
  say(out, json);
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...a] = argv;
  const json = flag(a, "--json");
  switch (cmd) {
    case "init": {
      const m = await migrateLegacy();
      const pc = await initPc();
      say(
        {
          migrated: m.moved,
          keptAtOldPlace: m.kept,
          store: m.to,
          pcRecipient: pc.recipient,
          created: pc.created,
        },
        json,
      );
      return 0;
    }
    case "add": {
      const name = a[0];
      if (!name) break;
      const kind = (opt(a, "--kind") ?? "token") as Kind;
      if (!KINDS.includes(kind)) break;
      const v = await stdinBytes();
      if (!v) return 2;
      await setSecret(name, v);
      await register(name, kind, list(opt(a, "--scope")));
      const scope = scopeOf(
        name,
        kind,
        await loadPolicy(),
        await loadRegistry(),
      );
      const sealed = scope.some((h) => h !== "pc")
        ? await sealOutbox(scope.filter((h) => h !== "pc"))
        : [];
      say(
        {
          name,
          len: v.byteLength,
          kind,
          scope,
          sealed: sealed.map((s) => `${s.host}:${s.sealed}`),
        },
        json,
      );
      v.fill(0);
      return 0;
    }
    case "import-chrome-csv": {
      if (!a[0]) break;
      say(await importChromeCsv(a[0], { keep: flag(a, "--keep") }), json);
      return 0;
    }
    case "export-chrome-csv": {
      if (!a[0]) break;
      say(await exportChromeCsv(a[0]), json);
      return 0;
    }
    case "doc": {
      const [sub, name, format] = a;
      if (sub === "list") {
        const docs = await listDocuments();
        say(
          await Promise.all(
            docs.map(async (d) => ({
              ...d,
              ...(await documentInfo(d.name, d.format)),
            })),
          ),
          json,
        );
        return 0;
      }
      if (!name || !FORMATS.includes(format as DocFormat)) break;
      if (sub === "put") {
        const v = await stdinBytes(false);
        if (!v) return 2;
        await writeDocument(name, format as DocFormat, v, {
          hello: flag(a, "--hello"),
        });
        say({ name, format, len: v.byteLength }, json);
        v.fill(0);
        return 0;
      }
      if (sub === "rm")
        return (await deleteDocument(name, format as DocFormat), 0);
      if (sub === "pipe") {
        const sep = a.indexOf("--");
        const command = sep < 0 ? [] : a.slice(sep + 1);
        if (!command.length) break;
        const doc = await readDocument(name, format as DocFormat);
        if (doc === undefined)
          return (console.error(`vault: no document ${name}.${format}`), 1);
        const bytes =
          format === "bin"
            ? (doc as Uint8Array)
            : encodeDoc(
                format as DocFormat,
                format === "csv" ? doc : format === "json" ? doc : String(doc),
              );
        const p = Bun.spawn(command, {
          stdin: bytes,
          stdout: "inherit",
          stderr: "inherit",
        });
        return await p.exited;
      }
      break;
    }
    case "sync": {
      if (flag(a, "--install-task")) {
        const m = Number(a[a.indexOf("--install-task") + 1]) || 5;
        say(await installTask(m), json);
        return 0;
      }
      if (flag(a, "--push-only")) {
        const p = await pushOnly({
          force: flag(a, "--force"),
          only: list(opt(a, "--host")),
        });
        say(p, json);
        return p.pushed.every((x) => !("error" in x) || !x.error) ? 0 : 1;
      }
      let r: Awaited<ReturnType<typeof sync>>;
      try {
        r = await sync({
          force: flag(a, "--force"),
          only: list(opt(a, "--host")),
        });
      } catch (e) {
        // The scheduled task has no console: failures land in state/last-error.json.
        await Bun.write(
          `${vaultRoot()}/state/last-error.json`,
          JSON.stringify({
            at: new Date().toISOString(),
            error: (e as Error).message,
          }),
        );
        throw e;
      }
      say(r, json);
      return r.pushed.every((p) => !("error" in p) || !p.error) ? 0 : 1;
    }
    case "status":
      await status(flag(a, "--remote"), json);
      return 0;
    case "rotate": {
      if (flag(a, "--master")) {
        const docs = await listDocuments();
        const plain = await Promise.all(
          docs.map(async (d) => ({
            ...d,
            info: await documentInfo(d.name, d.format),
            v: await readDocument(d.name, d.format),
          })),
        );
        const { forgetMasterKey, MASTER } = await import("./crypto.ts");
        await setSecret(MASTER, crypto.getRandomValues(new Uint8Array(32)));
        forgetMasterKey();
        await masterKey(false);
        for (const d of plain)
          await writeDocument(
            d.name,
            d.format,
            d.format === "bin" ? d.v : encodeDoc(d.format, d.v as never),
            { hello: d.info.hello },
          );
        say(
          {
            rotated: "master",
            documents: plain.length,
            note: "sync indexes rebuilt on next sync",
          },
          json,
        );
        const { rm } = await import("node:fs/promises");
        for (const h of await loadHosts())
          await rm(`${vaultRoot()}/state/${h.name}.index.json`, {
            force: true,
          });
        return 0;
      }
      if (!a[0]) break;
      say(await rotateHost(a[0]), json);
      return 0;
    }
    case "host":
    case "hosts": {
      const [sub, h] = a.filter((x) => !x.startsWith("--"));
      if (!sub || sub === "list") {
        say(
          (await loadHosts()).map((x) => ({
            host: x.name,
            os: x.os,
            recipient: x.recipient ? `${x.recipient.slice(0, 12)}…` : "-",
          })),
          json,
        );
        return 0;
      }
      if (sub === "init" && h)
        return (say(h === "pc" ? await initPc() : await initHost(h), json), 0);
      if (sub === "install" && h) return (say(await installHost(h), json), 0);
      if (sub === "remove" && h)
        return (say(await removeHost(h, flag(a, "--force")), json), 0);
      break;
    }
    case "fp": {
      if (!a[0]) break;
      const h = opt(a, "--host");
      const fp =
        h && h !== "pc"
          ? await remoteFingerprint(h, a[0])
          : await localFingerprint(a[0]);
      say({ name: a[0], host: h ?? "pc", b3: fp ?? "absent" }, json);
      return fp ? 0 : 1;
    }
    case "backup":
      say(
        await backup(
          a.filter((x) => !x.startsWith("--")).length
            ? a.filter((x) => !x.startsWith("--"))
            : undefined,
        ),
        json,
      );
      return 0;
    case "restore":
      if (!a[0]) break;
      say(await restore(a[0], a[1]), json);
      return 0;
    case "hello": {
      if (!WIN) return (console.error("vault hello: Windows only"), 2);
      const name = await HELLO_KEY();
      if (a[0] === "status")
        return (
          say(
            { ...(await helloStatus(name)), key: name.split("//").pop() },
            json,
          ),
          0
        );
      if (a[0] === "enroll") {
        await helloEnroll(
          name,
          "Coffre aphrody : clé Windows Hello des documents",
        );
        say({ enrolled: true }, json);
        return 0;
      }
      break;
    }
    case "migrate-dpapi": {
      const { migrateDpapiV2 } = await import("./store.ts");
      say(await migrateDpapiV2(), json);
      return 0;
    }
    case "shred":
      if (!a[0]) break;
      say({ shreddedBytes: await shred(a[0]) }, json);
      return 0;
    case "b3": {
      const v = await stdinBytes();
      if (!v) return 2;
      say(await b3(v), json);
      return 0;
    }
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return 0;
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
