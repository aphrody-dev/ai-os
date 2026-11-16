// Agent CLI sign-ins without typing by an agent: only the final click returns to the owner.
//   claude : the owner runs `claude setup-token` on the PC and copies the token; it is read from the clipboard
//            (never displayed), stored in the vault (@aphrody/env-kit/vault, DPAPI), clipboard cleared, then delivered to the
//            hosts by the vault (per-host age envelope -> runner's systemd-creds --user, docs/infra/VAULT.md), verified.
//   codex  : `codex login --device-auth` in a tmux window on the host; the (public) device code is written to
//            <RELAY_HOME>/device-code.txt for the https://auth.openai.com/codex/device page opened at the owner's.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { relayHome } from "../relay/cdp";
import { register, setSecret, sync } from "@aphrody/env-kit/vault";

const TOKEN = /sk-ant-oat01-[A-Za-z0-9_-]{60,}/;
const DEVICE = /\b[A-Z0-9]{4}-[A-Z0-9]{5}/; // 9 characters; under ConPTY, the following text is stuck to the code

/** ssh targets of the runners: roles, Host aliases of ~/.ssh/config (jump host and key alias are configured there). */
const TARGETS: Record<string, string[]> = {
  prd: ["-l", "agent", "prd"],
  fr2: ["fr2"],
};
const ssh = (h: string, cmd: string, stdin?: string) =>
  Bun.spawnSync(
    [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=30",
      ...(TARGETS[h] ?? [h]),
      cmd,
    ],
    {
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
      timeout: 240_000,
    },
  );
const clip = () =>
  Bun.spawnSync([
    "pwsh",
    "-NoProfile",
    "-c",
    "Get-Clipboard -Raw",
  ]).stdout.toString();

/** Check on the host: the token delivered by the vault is read from the credstore and tested (never displayed). */
const VERIFY =
  "CLAUDE_CODE_OAUTH_TOKEN=$(systemd-creds --user decrypt --name=CLAUDE_CODE_OAUTH_TOKEN ~/.config/credstore.encrypted/CLAUDE_CODE_OAUTH_TOKEN - 2>/dev/null) " +
  "PATH=$HOME/.local/bin:/usr/local/bin:$PATH timeout 120 claude -p 'Reply with the single word: ok' --output-format text 2>&1 | head -c 200";

/** Launches `claude setup-token` in a bun PTY (Bun.Terminal): the browser opens, the owner clicks
 *  "Authorize", the localhost callback reaches the CLI and the token is extracted from the stream without being displayed or written
 *  to disk. Only status lines (URL, errors) are relayed, token masked. */
async function captureSetupToken(waitMin: number): Promise<string> {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  let buf = "";
  const term = new Bun.Terminal({
    cols: 400,
    rows: 50,
    data(_t, d) {
      const t = new TextDecoder()
        .decode(d)
        .replace(/\x1b\[\d*C/g, " ")
        .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      buf += t;
      if (/press enter/i.test(t)) term.write("\r");
      for (const l of t.split(/\r?\n/)) {
        const x = l.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[secret]").trim();
        if (x && /http|error|success|token|expire/i.test(x))
          console.error(x.slice(0, 200));
      }
    },
  });
  const p = Bun.spawn(["claude", "setup-token"], { env, terminal: term });
  const timer = setTimeout(() => p.kill(), waitMin * 60_000);
  await p.exited;
  clearTimeout(timer);
  term.close();
  // The CLI spaces words with cursor moves (CSI n C, converted to spaces); without that the next word
  // ("Store") stuck to the token. The token may also be split by a formatting line break.
  return TOKEN.exec(buf)?.[0] ?? TOKEN.exec(buf.replace(/\s+/g, ""))?.[0] ?? "";
}

export async function login(
  cli: string,
  hosts = ["prd", "fr2"],
  waitMin = 30,
  fromClipboard = false,
) {
  if (cli === "claude") {
    const deadline = Date.now() + waitMin * 60_000;
    let tok = fromClipboard ? "" : await captureSetupToken(waitMin);
    while (fromClipboard && Date.now() < deadline && !tok) {
      tok = TOKEN.exec(clip())?.[0] ?? "";
      if (!tok) await Bun.sleep(3000);
    }
    if (!tok)
      return {
        cli,
        ok: false,
        error: "no sk-ant-oat01 token on the clipboard",
      };
    Bun.spawnSync(["pwsh", "-NoProfile", "-c", "Set-Clipboard -Value $null"]);
    // Vault: local DPAPI, PC + hosts scope, age envelopes pushed right away (the timer picks up otherwise).
    const remote = hosts.filter((h) => h !== "pc" && h !== "local");
    await setSecret("CLAUDE_CODE_OAUTH_TOKEN", tok);
    await register("CLAUDE_CODE_OAUTH_TOKEN", "token", ["pc", ...remote]);
    const delivered = await sync({ force: true, only: remote }).catch(
      (e: Error) => ({ error: e.message }),
    );
    const out: Record<string, unknown> = {
      cli,
      vault: true,
      sync:
        "pushed" in delivered
          ? delivered.pushed.map(
              (p) => `${p.host}:${p.pushed ? "ok" : (p.error ?? "unchanged")}`,
            )
          : delivered.error,
    };
    for (const h of remote) {
      const r = ssh(h, VERIFY);
      out[h] = {
        exit: r.exitCode,
        reply: r.stdout
          .toString()
          .replace(TOKEN, "[secret]")
          .trim()
          .slice(0, 80),
      };
    }
    return out;
  }
  if (cli === "codex") {
    const out: Record<string, unknown> = { cli };
    for (const h of hosts) {
      if (h === "pc" || h === "local") {
        out[h] = await codexLocal(waitMin);
        continue;
      }
      const st = ssh(
        h,
        "PATH=$HOME/.local/bin:$HOME/.bun/bin:$PATH codex login status 2>&1 | head -1",
      )
        .stdout.toString()
        .trim();
      if (/logged in/i.test(st) && !/not logged/i.test(st)) {
        out[h] = { ok: true, status: st };
        continue;
      }
      ssh(
        h,
        'tmux kill-window -t agents:login-codex 2>/dev/null; tmux new-window -d -t agents -n login-codex "PATH=$HOME/.local/bin:$HOME/.bun/bin:$PATH codex login --device-auth; sleep 900"',
      );
      await Bun.sleep(12_000);
      const pane = ssh(
        h,
        "tmux capture-pane -p -t agents:login-codex",
      ).stdout.toString();
      const code = DEVICE.exec(pane)?.[0];
      if (code) {
        mkdirSync(relayHome(), { recursive: true });
        writeFileSync(join(relayHome(), "device-code.txt"), `${code}\n`);
      }
      out[h] = {
        ok: false,
        device_code_file: code ? join(relayHome(), "device-code.txt") : null,
        page: "https://auth.openai.com/codex/device",
      };
    }
    return out;
  }
  throw new Error(
    "usage : ai-os nhitl login claude|codex [--hosts prd,fr2,pc]",
  );
}

/** Codex on the local machine: device-auth in a PTY, code written to <RELAY_HOME>/device-code.txt, page opened. */
async function codexLocal(waitMin: number) {
  const codex = Bun.which("codex");
  if (!codex)
    return { ok: false, error: "codex missing (bun add -g @openai/codex)" };
  const status = () =>
    Bun.spawnSync([codex, "login", "status"])
      .stdout.toString()
      .trim()
      .split("\n")[0] ?? "";
  if (/logged in/i.test(status()) && !/not logged/i.test(status()))
    return { ok: true, status: status() };
  let seen = "";
  let code: string | undefined;
  const term = new Bun.Terminal({
    cols: 160,
    rows: 40,
    data(_t, d) {
      seen += new TextDecoder()
        .decode(d)
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      if (!code && (code = DEVICE.exec(seen)?.[0])) {
        mkdirSync(relayHome(), { recursive: true });
        writeFileSync(join(relayHome(), "device-code.txt"), `${code}\n`);
        Bun.spawn(
          ["cmd", "/c", "start", "", "https://auth.openai.com/codex/device"],
          { stdio: ["ignore", "ignore", "ignore"] },
        );
      }
    },
  });
  const p = Bun.spawn([codex, "login", "--device-auth"], { terminal: term });
  const timer = setTimeout(() => p.kill(), waitMin * 60_000);
  const exit = await p.exited;
  clearTimeout(timer);
  term.close();
  return {
    ok: exit === 0,
    status: status(),
    device_code_file: code ? join(relayHome(), "device-code.txt") : null,
  };
}
