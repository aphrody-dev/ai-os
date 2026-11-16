// SPDX-License-Identifier: Apache-2.0
/**
 * Sync PC -> hosts, no human, no agent (Windows scheduled task `aphrody-vault-sync`):
 *
 * 1. seal: for every local secret whose scope includes a host, an age envelope to that host's
 *    recipient only, in <vault>/outbox/<host>/<NAME>.age. A keyed fingerprint (HMAC with the master
 *    key) per value skips unchanged secrets; envelopes leaving the scope are removed.
 * 2. push: MANIFEST (BLAKE3 of each envelope) + envelopes, as a tar over ssh (mesh) into
 *    `vault-host.sh receive`, which verifies the MANIFEST, swaps the inbox and applies it into the
 *    host's systemd-creds store. Skipped when the MANIFEST hash equals the last push, except every
 *    VAULT_REPUSH_HOURS (6) to repair drift.
 */

import {
  mkdir,
  open as fopen,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { ageEncrypt, ageKeygen, ageRecipientOf } from "./age.ts";
import {
  b3,
  b3Files,
  keyedFingerprint,
  masterKey,
  RESERVED,
} from "./crypto.ts";
import {
  forgetHost,
  type Host,
  loadHosts,
  loadPolicy,
  loadRegistry,
  scopeOf,
  setRecipient,
} from "./hosts.ts";
import { infraDir, vaultRoot, WIN } from "./paths.ts";
import { assertName, getSecretBytes, listSecrets, setSecret } from "./store.ts";

export const PC_IDENTITY = "VAULT_AGE_IDENTITY";
const outbox = (host: string) => join(vaultRoot(), "outbox", host);
const stateDir = () => join(vaultRoot(), "state");
const REMOTE = "~/.local/libexec/aphrody/vault-host.sh";

async function readJson<T>(f: string, d: T): Promise<T> {
  try {
    return JSON.parse(await readFile(f, "utf8")) as T;
  } catch {
    return d;
  }
}

// --- ssh ----------------------------------------------------------------------------------------

/** Runs `cmd` on the host: mesh route first, then each fallback when ssh cannot connect (255). A
 *  stream stdin can only be consumed once: it is buffered when fallbacks exist. */
export async function ssh(
  host: Host,
  cmd: string,
  stdin?: Uint8Array | ReadableStream,
  timeoutMs = 120_000,
) {
  const routes = [host.ssh, ...host.fallback];
  const input =
    stdin instanceof ReadableStream && routes.length > 1
      ? await new Response(stdin).bytes()
      : stdin;
  let last = { code: 255, out: "", err: "no route" };
  for (const route of routes) {
    const p = Bun.spawn(
      ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", ...route, cmd],
      {
        stdin: (input ?? "ignore") as never,
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    last = { code, out: out.trim(), err: err.trim() };
    if (code !== 255) return last;
  }
  return last;
}

// --- lock ---------------------------------------------------------------------------------------

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  const f = join(stateDir(), "sync.lock");
  try {
    if (Date.now() - (await stat(f)).mtimeMs > 15 * 60_000)
      await rm(f, { force: true });
  } catch {}
  let h = await fopen(f, "wx").catch(() => undefined);
  if (!h) {
    // A lock whose process is gone (task killed at its time limit) is taken over at once.
    const pid = Number(await readFile(f, "utf8").catch(() => "0"));
    let alive = false;
    try {
      alive = pid > 0 && process.kill(pid, 0);
    } catch {}
    if (!alive) {
      await rm(f, { force: true });
      h = await fopen(f, "wx").catch(() => undefined);
    }
  }
  if (!h) throw new Error("vault sync: another sync is running");
  try {
    await h.write(String(process.pid));
    return await fn();
  } finally {
    await h.close();
    await rm(f, { force: true });
  }
}

// --- PC identity ----------------------------------------------------------------------------------

/** Master key + PC age identity (both in the local layer); writes the PC recipient in hosts.toml. */
export async function initPc(): Promise<{
  recipient: string;
  created: boolean;
}> {
  await masterKey(true);
  let id = await getSecretBytes(PC_IDENTITY);
  let created = false;
  if (!id) {
    const k = await ageKeygen();
    await setSecret(PC_IDENTITY, k.identity);
    k.identity.fill(0);
    id = await getSecretBytes(PC_IDENTITY);
    created = true;
  }
  const recipient = await ageRecipientOf(id!);
  id!.fill(0);
  await setRecipient("pc", recipient);
  return { recipient, created };
}

// --- seal ----------------------------------------------------------------------------------------

export interface SealResult {
  host: string;
  sealed: number;
  unchanged: number;
  removed: number;
  total: number;
}

export async function sealOutbox(only?: string[]): Promise<SealResult[]> {
  const [hosts, policy, registry, names] = await Promise.all([
    loadHosts(),
    loadPolicy(),
    loadRegistry(),
    listSecrets(),
  ]);
  const remote = hosts.filter(
    (h) => h.name !== "pc" && h.recipient && (!only || only.includes(h.name)),
  );
  const results: SealResult[] = [];
  for (const host of remote) {
    const dir = outbox(host.name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const idxFile = join(stateDir(), `${host.name}.index.json`);
    const index = await readJson<Record<string, string>>(idxFile, {});
    const want = names.filter(
      (n) =>
        !RESERVED.has(n) &&
        (registry[n]?.kind ?? "token") === "token" &&
        scopeOf(n, registry[n]?.kind ?? "token", policy, registry).includes(
          host.name,
        ),
    );
    const r: SealResult = {
      host: host.name,
      sealed: 0,
      unchanged: 0,
      removed: 0,
      total: want.length,
    };
    for (const n of want) {
      const v = await getSecretBytes(n);
      if (!v) continue;
      const fp = await keyedFingerprint(
        `sync|${host.name}|${host.recipient}|${n}`,
        v,
      );
      const file = join(dir, `${n}.age`);
      const exists = await stat(file).then(
        () => true,
        () => false,
      );
      if (index[n] === fp && exists) {
        r.unchanged++;
        v.fill(0);
        continue;
      }
      const tmp = join(dir, `.${n}.tmp`);
      await writeFile(tmp, await ageEncrypt(v, [host.recipient]), {
        mode: 0o600,
      });
      await rename(tmp, file);
      v.fill(0);
      index[n] = fp;
      r.sealed++;
    }
    for (const f of await readdir(dir)) {
      const n = f.replace(/\.age$/, "");
      if (f === "MANIFEST" || (f.endsWith(".age") && want.includes(n)))
        continue;
      await rm(join(dir, f), { force: true });
      delete index[n];
      r.removed++;
    }
    for (const n of Object.keys(index)) if (!want.includes(n)) delete index[n];
    await mkdir(stateDir(), { recursive: true, mode: 0o700 });
    await writeFile(idxFile, JSON.stringify(index), { mode: 0o600 });
    results.push(r);
  }
  return results;
}

// --- push ----------------------------------------------------------------------------------------

/** MANIFEST: BLAKE3 per envelope, a monotonic `# seq` (hosts refuse replays) and `# allow-empty` when
 *  the scope of the host is empty on purpose. `text` (without seq) is what idempotence compares. */
async function manifest(
  host: string,
): Promise<{ text: string; files: string[] }> {
  const dir = outbox(host);
  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".age") && !f.startsWith("."))
    .sort();
  const sums = await b3Files(files.map((f) => join(dir, f)));
  const text =
    files.map((f) => `${sums.get(join(dir, f))}  ${f}`).join("\n") +
    (files.length ? "\n" : "# allow-empty\n");
  await writeFile(join(dir, "MANIFEST"), `# seq ${Date.now()}\n${text}`, {
    mode: 0o600,
  });
  return { text, files };
}

export interface PushResult {
  host: string;
  pushed: boolean;
  envelopes: number;
  manifest: string;
  remote?: string;
  error?: string;
}

const TAR = WIN
  ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
  : "tar";

export async function push(host: Host, force = false): Promise<PushResult> {
  const m = await manifest(host.name);
  const mh = await b3(new TextEncoder().encode(m.text));
  const stFile = join(stateDir(), `${host.name}.pushed.json`);
  const last = await readJson<{ manifest?: string; at?: number }>(stFile, {});
  const repush = Number(process.env.VAULT_REPUSH_HOURS ?? 6) * 3600_000;
  const base = {
    host: host.name,
    envelopes: m.files.length,
    manifest: mh.slice(0, 16),
  };
  if (!force && last.manifest === mh && Date.now() - (last.at ?? 0) < repush)
    return { ...base, pushed: false };
  const tar = Bun.spawn(
    [TAR, "-cf", "-", "-C", outbox(host.name), "MANIFEST", ...m.files],
    { stdout: "pipe", stderr: "pipe" },
  );
  const r = await ssh(host, `${REMOTE} receive`, tar.stdout);
  const tarCode = await tar.exited;
  if (tarCode !== 0 || r.code !== 0) {
    return {
      ...base,
      pushed: false,
      error: (r.err || `tar ${tarCode}`).split("\n").slice(-1)[0],
    };
  }
  await writeFile(
    stFile,
    JSON.stringify({ manifest: mh, at: Date.now(), remote: r.out }),
    { mode: 0o600 },
  );
  return { ...base, pushed: true, remote: r.out };
}

/** seal + push for every host with a recipient (or `only`). Never throws per host. */
export async function sync(opts: { force?: boolean; only?: string[] } = {}) {
  return withLock(async () => {
    const sealed = await sealOutbox(opts.only);
    const hosts = (await loadHosts()).filter((h) =>
      sealed.some((s) => s.host === h.name),
    );
    const pushed = await Promise.all(
      hosts.map((h) =>
        push(h, opts.force).catch((e) => ({
          host: h.name,
          pushed: false,
          envelopes: 0,
          manifest: "",
          error: (e as Error).message,
        })),
      ),
    );
    await writeFile(
      join(stateDir(), "last-sync.json"),
      JSON.stringify({ at: new Date().toISOString(), sealed, pushed }),
      { mode: 0o600 },
    );
    return { sealed, pushed };
  });
}

// --- host management -----------------------------------------------------------------------------

async function hostByName(name: string): Promise<Host> {
  const h = (await loadHosts()).find((x) => x.name === name);
  if (!h) throw new Error(`unknown host ${name} (device/vault/hosts.toml)`);
  return h;
}

/** Installs vault-host.sh and the user units (apply timer) on a host. */
export async function installHost(name: string) {
  const h = await hostByName(name);
  if (h.os !== "linux") throw new Error(`${name}: not a Linux host`);
  const script = await readFile(join(infraDir(), "vault-host.sh"));
  const a = await ssh(
    h,
    `mkdir -p ~/.local/libexec/aphrody && cat > ${REMOTE}.new && chmod 700 ${REMOTE}.new && mv -f ${REMOTE}.new ${REMOTE}`,
    script,
  );
  if (a.code !== 0) throw new Error(`${name}: install script: ${a.err}`);
  for (const u of [
    "aphrody-vault-apply.service",
    "aphrody-vault-apply.timer",
  ]) {
    const unit = await readFile(join(infraDir(), "systemd", u));
    const b = await ssh(
      h,
      `d=$([ "$(id -u)" = 0 ] && echo /etc/systemd/system || echo ~/.config/systemd/user); mkdir -p $d && cat > $d/${u}`,
      unit,
    );
    if (b.code !== 0) throw new Error(`${name}: install ${u}: ${b.err}`);
  }
  const tools = await ssh(
    h,
    "for t in age age-keygen b3sum systemd-creds tar flock; do command -v $t >/dev/null || echo $t; done",
  );
  if (tools.out)
    throw new Error(
      `${name}: missing tools: ${tools.out.split("\n").join(", ")}`,
    );
  const c = await ssh(
    h,
    `if [ "$(id -u)" = 0 ]; then S=; else S=--user; export XDG_RUNTIME_DIR=${"$"}{XDG_RUNTIME_DIR:-/run/user/$(id -u)}; loginctl show-user "$(id -un)" -p Linger | grep -q yes || echo "linger=no" >&2; fi; systemctl $S daemon-reload && systemctl $S enable --now aphrody-vault-apply.timer && systemctl $S is-active aphrody-vault-apply.timer`,
  );
  if (c.code !== 0 || c.out !== "active")
    throw new Error(`${name}: apply timer not active: ${c.err || c.out}`);
  return { host: name, timer: c.out, linger: !/linger=no/.test(c.err) };
}

/** Install + identity on the host (private key generated and sealed there) + recipient in hosts.toml. */
export async function initHost(name: string, force = false) {
  const inst = await installHost(name);
  const h = await hostByName(name);
  const r = await ssh(h, `${REMOTE} keygen${force ? " --force" : ""}`);
  const recipient = r.out.split("\n").pop() ?? "";
  if (r.code !== 0 || !/^age1[0-9a-z]{58}$/.test(recipient))
    throw new Error(`${name}: keygen failed: ${r.err}`);
  await setRecipient(name, recipient);
  return { ...inst, recipient };
}

/** New host identity, outbox resealed for it, pushed at once. */
export async function rotateHost(name: string) {
  const r = await initHost(name, true);
  await rm(join(stateDir(), `${name}.index.json`), { force: true });
  const s = await sync({ force: true, only: [name] });
  return { ...r, ...s };
}

/** Decommission: the host revokes every credential the vault applied, drops its inbox, identity and
 *  timer; then the PC purges its outbox and state and removes the host from the versioned config.
 *  `force` goes on with the local part when the host is unreachable (revocation left to do there). */
export async function removeHost(name: string, force = false) {
  if (name === "pc") throw new Error("the PC cannot be removed");
  const h = await hostByName(name);
  // Under the sync lock: a scheduled seal/push cannot recreate the outbox between purge and config.
  return withLock(async () => {
    const r = await ssh(h, `${REMOTE} decommission`);
    if (r.code !== 0 && !force)
      throw new Error(
        `${name}: decommission failed (${r.err || r.code}); --force to remove locally only`,
      );
    const cfg = await forgetHost(name);
    await rm(outbox(name), { recursive: true, force: true });
    for (const f of [`${name}.index.json`, `${name}.pushed.json`])
      await rm(join(stateDir(), f), { force: true });
    return {
      host: name,
      remote: r.code === 0 ? r.out : `unreachable: ${r.err}`,
      ...cfg,
    };
  });
}

/** BLAKE3 of the credential on a host (decrypted there, piped into b3sum: never displayed). */
export async function remoteFingerprint(
  name: string,
  secret: string,
): Promise<string> {
  assertName(secret); // validated before it reaches the remote shell
  const r = await ssh(await hostByName(name), `${REMOTE} fp ${secret}`);
  if (r.code !== 0) throw new Error(`${name}: fp failed: ${r.err}`);
  return r.out;
}

export async function remoteStatus(name: string): Promise<string> {
  const r = await ssh(await hostByName(name), `${REMOTE} status`);
  return r.code === 0 ? r.out : `error: ${r.err}`;
}

export async function localFingerprint(
  secret: string,
): Promise<string | undefined> {
  const v = await getSecretBytes(secret);
  if (!v) return undefined;
  try {
    return await b3(v);
  } finally {
    v.fill(0);
  }
}

// --- Windows scheduled task ----------------------------------------------------------------------

export const TASK = "aphrody-vault-sync";
export const PUSH_TASK = "aphrody-vault-push";

const xmlEsc = (s: string) => Bun.escapeHTML(s);

/**
 * Two tasks:
 * - `aphrody-vault-sync` (InteractiveToken: DPAPI user keys exist only in the logged-on session): seal +
 *   push, at logon, at every unlock (SessionStateChangeTrigger SessionUnlock) and every `minutes`;
 * - `aphrody-vault-push` (S4U: runs logged on or not, no DPAPI): pushes the envelopes already sealed in
 *   outbox/ (`sync --push-only`), so a host rebuilt or wiped while the session is closed is refilled.
 * Hidden (`conhost --headless` for the interactive one), one instance at a time, 10 minute limit.
 */
export function taskXml(
  user: string,
  minutes: number,
  cli: string,
  kind: "sync" | "push" = "sync",
): string {
  const push = kind === "push";
  const cmd = push
    ? process.execPath
    : join(process.env.SystemRoot ?? "C:\\Windows", "System32", "conhost.exe");
  const args = push
    ? `run "${cli}" sync --push-only`
    : `--headless "${process.execPath}" run "${cli}" sync`;
  const u = xmlEsc(user);
  const triggers = push
    ? ""
    : `
    <LogonTrigger><Enabled>true</Enabled><UserId>${u}</UserId><Delay>PT1M</Delay></LogonTrigger>
    <SessionStateChangeTrigger><Enabled>true</Enabled><StateChange>SessionUnlock</StateChange><UserId>${u}</UserId><Delay>PT30S</Delay></SessionStateChangeTrigger>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>aphrody vault: ${push ? "push sealed age envelopes (no DPAPI)" : "seal and push age envelopes"} to the fleet</Description></RegistrationInfo>
  <Triggers>${triggers}
    <TimeTrigger><Repetition><Interval>PT${minutes}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>${u}</UserId><LogonType>${push ? "S4U" : "InteractiveToken"}</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xmlEsc(cmd)}</Command><Arguments>${xmlEsc(args)}</Arguments><WorkingDirectory>${xmlEsc(vaultRoot())}</WorkingDirectory></Exec></Actions>
</Task>
`;
}

async function registerTask(name: string, xml: string) {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  const file = join(stateDir(), `${name}.xml`);
  // schtasks /XML expects UTF-16 LE with BOM.
  await writeFile(
    file,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]),
  );
  const p = Bun.spawn(
    ["schtasks", "/Create", "/TN", name, "/XML", file, "/F"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  await rm(file, { force: true });
  return { task: name, code, out: (out + err).trim() };
}

export async function installTask(minutes = 5) {
  if (!WIN)
    throw new Error(
      "installTask: Windows only (hosts use aphrody-vault-apply.timer)",
    );
  const domain = process.env.USERDOMAIN;
  const name = process.env.USERNAME;
  if (!domain || !name)
    throw new Error("installTask: USERDOMAIN/USERNAME absent");
  const user = `${domain}\\${name}`;
  const cli = join(import.meta.dir, "cli.ts");
  const sync = await registerTask(TASK, taskXml(user, minutes, cli, "sync"));
  if (sync.code !== 0) throw new Error(`schtasks ${TASK}: ${sync.out}`);
  // The S4U pusher refills hosts while the session is closed: every 15 min is enough.
  const push = await registerTask(
    PUSH_TASK,
    taskXml(user, Math.max(minutes, 15), cli, "push"),
  );
  if (push.code !== 0) throw new Error(`schtasks ${PUSH_TASK}: ${push.out}`);
  return [sync, push];
}

/** Pushes what outbox/ already holds: no seal, no DPAPI, no secret in clear (S4U task). */
export async function pushOnly(
  opts: { force?: boolean; only?: string[] } = {},
) {
  return withLock(async () => {
    const hosts = (await loadHosts()).filter(
      (h) =>
        h.name !== "pc" &&
        h.recipient &&
        (!opts.only || opts.only.includes(h.name)),
    );
    // Only an outbox a seal has completed (MANIFEST written) is pushed.
    const present = await Promise.all(
      hosts.map((h) =>
        stat(join(outbox(h.name), "MANIFEST")).then(
          () => true,
          () => false,
        ),
      ),
    );
    const pushed = await Promise.all(
      hosts
        .filter((_, i) => present[i])
        .map((h) =>
          push(h, opts.force).catch((e) => ({
            host: h.name,
            pushed: false,
            envelopes: 0,
            manifest: "",
            error: (e as Error).message,
          })),
        ),
    );
    await writeFile(
      join(stateDir(), "last-push.json"),
      JSON.stringify({ at: new Date().toISOString(), pushed }),
      { mode: 0o600 },
    );
    return { pushed };
  });
}
