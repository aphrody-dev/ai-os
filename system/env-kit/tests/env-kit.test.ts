import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "../src/spawn.ts";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncAllEditorConfigs } from "../src/editors";
import {
  exportForCloudflareDevVars,
  exportForVercelEnv,
  loadMonorepoEnv,
  parseDotEnv,
  redactEnv,
  resolveMonorepoEnvPath,
  upsertEnvFileKey,
} from "../src/index";

const LOADERS = join(import.meta.dir, "..", "loaders");

// Isolation: these tests read process.env before files, so the real environment (tokens, keys) must not be visible.
// Only the variables a child process needs to start survive; HOME and USERPROFILE point to an empty temp directory.
const KEEP = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG)$/i;
let savedEnv: Record<string, string | undefined> = {};
let fakeHome = "";
beforeAll(() => {
  savedEnv = { ...process.env };
  fakeHome = mkdtempSync(join(tmpdir(), "env-kit-home-"));
  for (const k of Object.keys(process.env)) if (!KEEP.test(k)) delete process.env[k];
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
});
afterAll(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  rmSync(fakeHome, { recursive: true, force: true });
});

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "env-kit-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("env-kit Bun/TypeScript core", () => {
  test("parses comments, export prefix, quotes, and escape sequences", () => {
    const parsed = parseDotEnv(`
      # Header comment
      SIMPLE_VAL=alpha_123 # inline comment
      export DOUBLE_QUOTED="line1\\nline2\\t\\"ok\\""
      SINGLE_QUOTED='literal \\n # hash stays'
      EMPTY_KEY=
    `);

    expect(parsed.SIMPLE_VAL).toBe("alpha_123");
    expect(parsed.DOUBLE_QUOTED).toBe('line1\nline2\t"ok"');
    expect(parsed.SINGLE_QUOTED).toBe("literal \\n # hash stays");
    expect(parsed.EMPTY_KEY).toBe("");
  });

  test("walks upward to nearest .env and respects override=false", () => {
    withTempDir((dir) => {
      const rootEnv = join(dir, ".env");
      const nested = join(dir, "apps", "worker", "src");
      writeFileSync(
        rootEnv,
        [
          "SYNTHETIC_FORGE_TOKEN=ghp_mock_token_value_1234567890",
          "SYNTHETIC_PROJECT_ID=aphrody-test",
          "SERVICE_MODE=production",
        ].join("\n"),
        "utf8",
      );
      mkdirSync(nested, { recursive: true });

      expect(resolveMonorepoEnvPath(nested)).toBe(rootEnv);

      process.env.SERVICE_MODE = "local_override";
      try {
        const loaded = loadMonorepoEnv({
          startDir: nested,
          service: "worker-api",
          required: ["SYNTHETIC_FORGE_TOKEN", "SYNTHETIC_PROJECT_ID"],
          override: false,
          injectProcessEnv: false,
        });

        expect(loaded.get("SERVICE_MODE")).toBe("local_override");
        expect(loaded.require("SYNTHETIC_PROJECT_ID")).toBe("aphrody-test");

        const serialized = JSON.stringify(loaded);
        expect(serialized).not.toContain("ghp_mock_token_value_1234567890");
        expect(serialized).toContain("SET [len=31]");

        const inspected = Bun.inspect(loaded);
        expect(inspected).not.toContain("ghp_mock_token_value_1234567890");
      } finally {
        delete process.env.SERVICE_MODE;
      }
    });
  });

  test("throws masked error when required keys are missing", () => {
    withTempDir((dir) => {
      const envFile = join(dir, ".env");
      writeFileSync(envFile, "GOOGLE_CLOUD_PROJECT=aphrody\n", "utf8");

      expect(() =>
        loadMonorepoEnv({
          envPath: envFile,
          service: "billing-engine",
          required: ["MISSING_SYNTHETIC_SECRET_KEY"],
          injectProcessEnv: false,
        }),
      ).toThrow(/\[service=billing-engine\].*MISSING_SYNTHETIC_SECRET_KEY/);
    });
  });

  test("redactEnv masks secret keys and secret value prefixes", () => {
    const view = redactEnv({
      ANTHROPIC_API_KEY: "synthetic_key_val_22ch",
      GOOGLE_CLOUD_PROJECT: "aphrody",
      CUDA_PATH: "C:\\Program Files\\NVIDIA\\CUDA\\v13.4",
      CUSTOM_PLAIN_FLAG: `${"figd"}_mock_prefixed_token_999`,
    });

    expect(view.ANTHROPIC_API_KEY).toBe("SET [len=22]");
    expect(view.GOOGLE_CLOUD_PROJECT).toBe("aphrody");
    expect(view.CUDA_PATH).toBe("C:\\Program Files\\NVIDIA\\CUDA\\v13.4");
    expect(view.CUSTOM_PLAIN_FLAG).toBe("SET [len=28]");
  });

  test("generates gitignored .dev.vars for Cloudflare wrangler dev and Vercel export", () => {
    withTempDir((dir) => {
      const envFile = join(dir, ".env");
      const workerDir = join(dir, "worker");
      writeFileSync(
        envFile,
        [
          "CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef",
          "GEMINI_API_KEY=AIzaMockTestKeyForUnitSpecOnly1234",
          "CARGO_HOME=/home/user/.cargo",
        ].join("\n"),
        "utf8",
      );

      upsertEnvFileKey(envFile, "NEON_API_KEY", "napi_mock_test_key_98765");

      const { devVarsPath, writtenKeys } = exportForCloudflareDevVars(
        workerDir,
        {
          envPath: envFile,
        },
      );
      expect(existsSync(devVarsPath)).toBe(true);
      expect(writtenKeys).toContain("CLOUDFLARE_ACCOUNT_ID");
      expect(writtenKeys).toContain("GEMINI_API_KEY");
      expect(writtenKeys).toContain("NEON_API_KEY");
      expect(writtenKeys).not.toContain("CARGO_HOME");

      const devVarsText = readFileSync(devVarsPath, "utf8");
      // boolean assertion: a failing toContain would print the whole file, which may hold secrets
      expect(devVarsText.includes("CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef")).toBe(true);

      const vercel = exportForVercelEnv({ envPath: envFile });
      expect(vercel.summary.GEMINI_API_KEY).toBe("SET [len=34]");
      expect(vercel.summary.CARGO_HOME).toBeUndefined();
    });
  });

  test("syncAllEditorConfigs preserves UI settings while wiring providers and MCPs", () => {
    withTempDir((dir) => {
      const zedDir = join(dir, "Roaming", "Zed");
      mkdirSync(zedDir, { recursive: true });
      writeFileSync(
        join(zedDir, "settings.json"),
        `// Comment header\n{\n  "ui_font_size": 16,\n  "theme": { "dark": "One Dark", },\n}\n`,
        "utf8",
      );

      const res = syncAllEditorConfigs({
        homeDir: dir,
        appDataDir: join(dir, "Roaming"),
        env: {
          CLOUDFLARE_API_TOKEN: "cf-test-tok",
          VERCEL_TOKEN: "vc-test-tok",
        },
      });

      expect(existsSync(res.opencodePath)).toBe(true);
      expect(existsSync(res.zedPath)).toBe(true);
      expect(existsSync(res.piSettingsPath)).toBe(true);
      expect(existsSync(res.piModelsPath)).toBe(true);
      expect(existsSync(res.antigravityCliMcpPath)).toBe(true);
      expect(existsSync(res.antigravityGlobalMcpPath)).toBe(true);
      expect(existsSync(res.geminiSettingsPath)).toBe(true);

      const agyMcp = JSON.parse(
        readFileSync(res.antigravityCliMcpPath, "utf8"),
      );
      expect(agyMcp.mcpServers["ai-os"].command).toBe(
        join(
          dir,
          ".local",
          "bin",
          process.platform === "win32" ? "ai-os.exe" : "ai-os",
        ),
      );
      expect(agyMcp.mcpServers["cloudflare-docs"].url).toBe(
        "https://docs.mcp.cloudflare.com/mcp",
      );
      expect(agyMcp.mcpServers.cloudflare.headers.Authorization).toBe(
        "Bearer cf-test-tok",
      );
      expect(agyMcp.mcpServers.vercel.headers.Authorization).toBe(
        "Bearer vc-test-tok",
      );

      const ocJson = JSON.parse(readFileSync(res.opencodePath, "utf8"));
      expect(ocJson.providers.anthropic.apiKey).toBe("{env:ANTHROPIC_API_KEY}");
      expect(ocJson.providers.google.apiKey).toBe("{env:GEMINI_API_KEY}");
      expect(ocJson.providers.ring3_local.baseUrl).toBe(
        "http://127.0.0.1:8787/v1",
      );
      expect(ocJson.providers.locally_uncensored.baseUrl).toBe(
        "http://127.0.0.1:8129/v1",
      );
      expect(ocJson.mcp.figma.environment.FIGMA_ACCESS_TOKEN).toBe(
        "{env:FIGMA_ACCESS_TOKEN}",
      );

      const zedRaw = readFileSync(res.zedPath, "utf8");
      expect(zedRaw).toContain('"ui_font_size": 16');
      expect(zedRaw).toContain('"ring3_agent"');
      expect(zedRaw).toContain('"native-hardware-cuda"');
    });
  });
});

describe("env-kit cross-language loaders integration", () => {
  test("Python sovereign_env.py parses and redacts secrets cleanly", () => {
    withTempDir((dir) => {
      const envFile = join(dir, ".env");
      writeFileSync(
        envFile,
        'SYNTH_PY_TOKEN="ghp_py_mock_secret_12345"\nSYNTH_PY_PROJECT=aphrody-py\n',
        "utf8",
      );

      const pyScript = `
import sys
sys.path.insert(0, r"${join(LOADERS, "python")}")
import sovereign_env
env = sovereign_env.load_monorepo_env(
    env_path=r"${envFile}",
    service="py-spec",
    required=["SYNTH_PY_TOKEN", "SYNTH_PY_PROJECT"],
    inject_process_env=False,
)
assert env["SYNTH_PY_TOKEN"] == "ghp_py_mock_secret_12345"
assert env["SYNTH_PY_PROJECT"] == "aphrody-py"
rep = repr(env)
assert "ghp_py_mock_secret_12345" not in rep
assert "SET [len=24]" in rep
print("PY_OK")
`;
      const res = spawnSync("python", ["-c", pyScript], { encoding: "utf8" });
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe("PY_OK");
    });
  });

  test.skipIf(process.platform !== "win32")(
    "PowerShell load-env.ps1 loads variables without overriding existing process env",
    () => {
      withTempDir((dir) => {
        const envFile = join(dir, ".env");
        writeFileSync(
          envFile,
          "SYNTH_PS_KEY=from_dotenv\nSYNTH_PS_EXISTING=from_dotenv\n",
          "utf8",
        );

        const cmd = `
$env:SYNTH_PS_EXISTING = 'keep_me'
. '${join(LOADERS, "shell", "load-env.ps1")}' -EnvPath '${envFile}' -Required @('SYNTH_PS_KEY')
if ($env:SYNTH_PS_KEY -ne 'from_dotenv') { exit 2 }
if ($env:SYNTH_PS_EXISTING -ne 'keep_me') { exit 3 }
Write-Output 'PS_OK'
`;
        const res = spawnSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", cmd],
          { encoding: "utf8" },
        );
        expect(res.status).toBe(0);
        expect(res.stdout.trim()).toBe("PS_OK");
      });
    },
  );
});

// Golden vectors (strict grammar: one line per key, closed quotes): every loader must agree.
describe("dotenv golden vectors", () => {
  const vectors = join(import.meta.dir, "vectors");
  const file = join(vectors, "dotenv.env");
  const expected: Record<string, string> = JSON.parse(
    readFileSync(join(vectors, "dotenv.json"), "utf8"),
  );

  test("TypeScript parseDotEnv", () => {
    const got = parseDotEnv(readFileSync(file, "utf8"));
    for (const [k, v] of Object.entries(expected))
      expect([k, got[k]]).toEqual([k, v]);
  });

  test("Python sovereign_env.parse_dotenv", () => {
    const py = `import importlib.util as u, json, sys
s = u.spec_from_file_location("m", sys.argv[1]); m = u.module_from_spec(s); s.loader.exec_module(m)
print(json.dumps(m.parse_dotenv(open(sys.argv[2], encoding="utf-8").read())))`;
    const res = spawnSync(
      "python",
      ["-I", "-c", py, join(LOADERS, "python", "sovereign_env.py"), file],
      { encoding: "utf8" },
    );
    if (res.error) return; // no python on this host
    const got = JSON.parse(res.stdout);
    for (const [k, v] of Object.entries(expected))
      expect([k, got[k]]).toEqual([k, v]);
  });

  test.skipIf(process.platform === "win32" && !Bun.which("sh"))(
    "POSIX sh load-env.sh",
    () => {
      // Empty environment: the loader exports only the vector file, then bun prints what it sees.
      const res = spawnSync(
        "sh",
        [
          "-c",
          'f="$1"; l="$2"; b="$3"; set -- "$f"; . "$l"; exec "$b" --no-env-file -e "console.log(JSON.stringify(process.env))"',
          "sh",
          file,
          join(LOADERS, "shell", "load-env.sh"),
          process.execPath,
        ],
        {
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "" },
          cwd: tmpdir(),
        },
      );
      expect(res.status).toBe(0);
      const got = JSON.parse(res.stdout);
      // The sh loader never exports empty values (it would clobber nothing): unset == "".
      for (const [k, v] of Object.entries(expected))
        expect([k, got[k] ?? ""]).toEqual([k, v]);
    },
  );
});
