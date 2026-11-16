// `auth login [service]` dispatch, toast payload, protocol registration and identity binary: pure, no toast shown.
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLI_ALIASES,
  type Deps,
  dispatchLogin,
  findService,
  type Service,
} from "../src/auth-services.ts";
import {
  loginUri,
  parseLoginUri,
  protocolScheme,
  registrationCommands,
  toastXml,
} from "../src/auth-toast.ts";
import { cliBinary, identityRoot, productBinary } from "../src/identity.ts";

const check = (target: string) => ({
  kind: "browser",
  target,
  host: "pc",
  status: "action" as const,
  proof: `${target} not signed in`,
});

function harness(over: Partial<Deps> = {}) {
  const calls: string[] = [];
  const out: string[] = [];
  const svc: Service = {
    id: "gemini-web",
    aliases: ["gemini"],
    label: "Gemini web",
    probe: async () => check("gemini-web"),
    login: async () => {
      calls.push("service:gemini-web");
      return 0;
    },
  };
  const deps: Deps = {
    services: [svc],
    runCli: async (t) => {
      calls.push(`cli:${t.join(",")}`);
      return 0;
    },
    attention: async () => [check("gemini-web"), check("gh")],
    isTTY: false,
    ask: () => null,
    out: (s) => out.push(s),
    ...over,
  };
  return { deps, calls, out };
}

test("identity: the binary name comes from tools/identity.toml, per root", () => {
  expect(cliBinary()).toBe("ay");
  expect(productBinary("ai-os")).toBe("ai-os");
  const d = mkdtempSync(join(tmpdir(), "idt-"));
  try {
    mkdirSync(join(d, "tools"));
    writeFileSync(join(d, "tools", "identity.toml"), '[cli]\nbinary = "zz"\n');
    expect(cliBinary(d)).toBe("zz");
    expect(productBinary("nope", d)).toBe("nope");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
  expect(identityRoot()).toContain("");
});

test("login URI: round trip, foreign schemes and malformed links refused", () => {
  expect(loginUri("gemini-web")).toBe(`${protocolScheme()}://login/gemini-web`);
  expect(parseLoginUri(loginUri("gemini-web"))).toBe("gemini-web");
  expect(parseLoginUri(loginUri())).toBe("");
  expect(parseLoginUri("evil://login/gemini-web")).toBeUndefined();
  expect(parseLoginUri(`${protocolScheme()}://login/a b`)).toBeUndefined();
});

test("toast: escaped, one click and one button launch the sign-in link, no script path anywhere", () => {
  const xml = toastXml({
    title: "Gemini <web>",
    lines: ["Click to sign in."],
    launch: loginUri("gemini-web"),
  });
  expect(xml).toContain(`launch="${loginUri("gemini-web")}"`);
  expect(xml).toContain('activationType="protocol"');
  expect(xml).toContain("Gemini &#60;web&#62;");
  const reg = registrationCommands("C:\\bin\\ay.exe").flat().join(" ");
  expect(reg).toContain(`"C:\\bin\\ay.exe" auth login --uri "%1"`);
  expect(`${xml} ${reg}`).not.toMatch(/\.ts\b|packages[\\/]/);
});

test("dispatch: service name, alias, CLI alias and login link", async () => {
  let h = harness();
  expect(await dispatchLogin(["gemini-web"], h.deps)).toBe(0);
  expect(h.calls).toEqual(["service:gemini-web"]);
  h = harness();
  await dispatchLogin(["gemini"], h.deps);
  expect(h.calls).toEqual(["service:gemini-web"]);
  h = harness();
  await dispatchLogin(["github", "cloudflare"], h.deps);
  expect(h.calls).toEqual(["cli:gh,cf"]);
  expect(CLI_ALIASES.github).toBe("gh");
  h = harness();
  await dispatchLogin(["--uri", loginUri("gemini-web")], h.deps);
  expect(h.calls).toEqual(["service:gemini-web"]);
  h = harness();
  expect(await dispatchLogin(["--uri", "evil://login/x"], h.deps)).toBe(2);
  expect(h.calls).toEqual([]);
  expect(findService("gemini", h.deps.services)?.id).toBe("gemini-web");
});

test("no argument: nothing to do says so; without a terminal everything pending is signed in; with one, a pick", async () => {
  let h = harness({ attention: async () => [] });
  expect(await dispatchLogin([], h.deps)).toBe(0);
  expect(h.out).toEqual(["Nothing needs attention."]);

  h = harness();
  await dispatchLogin([], h.deps);
  expect(h.calls).toEqual(["service:gemini-web", "cli:gh"]);

  h = harness({ isTTY: true, ask: () => "1" });
  await dispatchLogin([], h.deps);
  expect(h.calls).toEqual(["service:gemini-web"]);
  expect(h.out.join("\n")).toContain("1. gemini-web");
  expect(h.out.join("\n")).toContain("2. gh");

  h = harness({ isTTY: true, ask: () => "a" });
  await dispatchLogin([], h.deps);
  expect(h.calls).toEqual(["service:gemini-web", "cli:gh"]);

  h = harness({ isTTY: true, ask: () => null });
  expect(await dispatchLogin([], h.deps)).toBe(0);
  expect(h.calls).toEqual([]);

  h = harness({ isTTY: true, ask: () => "9" });
  expect(await dispatchLogin([], h.deps)).toBe(2);
});

test("a failing sign-in is the exit code", async () => {
  const h = harness();
  h.deps.services[0]!.login = async () => 1;
  expect(await dispatchLogin(["gemini-web"], h.deps)).toBe(1);
});
