import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_NEXUS_DB_PATH, openNexusDb } from "../nexus/brain-memory.ts";
import { stripEmojis, writeFileSafeUserspace } from "../nexus/security.ts";

export const DEFAULT_NIX_STORE_ROOT =
  process.platform === "win32"
    ? "C:\\src\\var\\nix\\store"
    : "/src/var/nix/store";

const NIX_BASE32_ALPHABET = "0123456789abcdfghijklmnpqrsvwxyz";

export interface NixDerivationInput {
  name: string;
  version: string;
  system?: string;
  tier: "tier1-rust-bun" | "tier2-proven-accelerator";
  language:
    | "rust"
    | "typescript-bun"
    | "wasm32-wgsl"
    | "cuda-cpp"
    | "zig"
    | "python-uv"
    | "go"
    | "dotnet-aot";
  upstreamUrl?: string;
  builderScript: string;
  outputs?: Record<string, string>;
}

export interface NixStoreEntry {
  drvHash: string;
  virtualStorePath: string;
  hostStorePath: string;
  name: string;
  version: string;
  system: string;
  tier: NixDerivationInput["tier"];
  language: NixDerivationInput["language"];
  upstreamUrl?: string;
  createdAt: string;
}

export interface NixGenerationRecord {
  generation: number;
  manifestHash: string;
  storePaths: string[];
  active: boolean;
  createdAt: string;
}

export interface AphrodyRepoClassification {
  name: string;
  htmlUrl: string;
  description: string;
  domain:
    | "posix-nix-kernel"
    | "ai-llm-compute"
    | "ui-terminal-editor"
    | "cloud-edge-infra";
  primaryStack: string;
  distilledRole: string;
}

export function computeNixBase32Hash(payload: string): string {
  const digest = new Uint8Array(
    Bun.CryptoHasher.hash("sha256", payload).buffer,
  );
  let out = "";
  for (let i = 0; i < 32; i++) {
    const b1 = digest[i % digest.length]!;
    const b2 = digest[(i * 7 + 3) % digest.length]!;
    out += NIX_BASE32_ALPHABET[(b1 ^ (b2 >> 2)) & 31]!;
  }
  return out;
}

function ensureNixTables(dbPath = DEFAULT_NEXUS_DB_PATH) {
  const db = openNexusDb(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS nix_derivations (
      drv_hash TEXT PRIMARY KEY,
      virtual_store_path TEXT NOT NULL,
      host_store_path TEXT NOT NULL,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      system TEXT NOT NULL,
      tier TEXT NOT NULL,
      language TEXT NOT NULL,
      upstream_url TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nix_generations (
      generation INTEGER PRIMARY KEY AUTOINCREMENT,
      manifest_hash TEXT NOT NULL,
      store_paths_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

export function realizeNixDerivation(
  drv: NixDerivationInput,
  options?: { storeRoot?: string; dbPath?: string },
): NixStoreEntry {
  const storeRoot = options?.storeRoot ?? DEFAULT_NIX_STORE_ROOT;
  const system = drv.system ?? `${process.arch}-${process.platform}`;
  const canonicalSpec = JSON.stringify({
    name: drv.name,
    version: drv.version,
    system,
    tier: drv.tier,
    language: drv.language,
    builderScript: drv.builderScript,
    outputs: drv.outputs ?? {},
  });

  const drvHash = computeNixBase32Hash(canonicalSpec);
  const slug = `${drvHash}-${drv.name}-${drv.version}`;
  const virtualStorePath = `/nix/store/${slug}`;
  const hostStorePath = join(storeRoot, slug).replace(/\\/g, "/");

  mkdirSync(hostStorePath, { recursive: true });
  writeFileSync(
    join(hostStorePath, "derivation.json"),
    `${JSON.stringify(
      {
        drvHash,
        virtualStorePath,
        name: drv.name,
        version: drv.version,
        system,
        tier: drv.tier,
        language: drv.language,
        upstreamUrl: drv.upstreamUrl,
        builderScript: drv.builderScript,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  if (drv.outputs) {
    for (const [relPath, content] of Object.entries(drv.outputs)) {
      writeFileSafeUserspace(join(hostStorePath, relPath), content);
    }
  }

  const createdAt = new Date().toISOString();
  const db = ensureNixTables(options?.dbPath);
  db.query(
    `INSERT OR REPLACE INTO nix_derivations
     (drv_hash, virtual_store_path, host_store_path, name, version, system, tier, language, upstream_url, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  ).run(
    drvHash,
    virtualStorePath,
    hostStorePath,
    drv.name,
    drv.version,
    system,
    drv.tier,
    drv.language,
    drv.upstreamUrl ?? null,
    createdAt,
  );

  return {
    drvHash,
    virtualStorePath,
    hostStorePath,
    name: drv.name,
    version: drv.version,
    system,
    tier: drv.tier,
    language: drv.language,
    upstreamUrl: drv.upstreamUrl,
    createdAt,
  };
}

export function switchNixGeneration(
  entries: NixStoreEntry[],
  dbPath = DEFAULT_NEXUS_DB_PATH,
): NixGenerationRecord {
  const db = ensureNixTables(dbPath);
  const storePaths = entries.map((e) => e.virtualStorePath).sort();
  const manifestHash = computeNixBase32Hash(storePaths.join("\n"));
  const createdAt = new Date().toISOString();

  db.exec(`UPDATE nix_generations SET active = 0`);
  const res = db
    .query(
      `INSERT INTO nix_generations (manifest_hash, store_paths_json, active, created_at)
       VALUES (?1, ?2, 1, ?3)`,
    )
    .run(manifestHash, JSON.stringify(storePaths), createdAt);

  return {
    generation: Number(res.lastInsertRowid),
    manifestHash,
    storePaths,
    active: true,
    createdAt,
  };
}

export function rollbackNixGeneration(
  targetGeneration?: number,
  dbPath = DEFAULT_NEXUS_DB_PATH,
): NixGenerationRecord | null {
  const db = ensureNixTables(dbPath);
  const rows = listNixGenerations(dbPath);
  if (rows.length === 0) return null;
  const target =
    targetGeneration !== undefined
      ? rows.find((r) => r.generation === targetGeneration)
      : rows.length >= 2
        ? rows[rows.length - 2]
        : rows[0];
  if (!target) return null;
  db.exec(`UPDATE nix_generations SET active = 0`);
  db.query(`UPDATE nix_generations SET active = 1 WHERE generation = ?1`).run(
    target.generation,
  );
  return { ...target, active: true };
}

export function listNixGenerations(
  dbPath = DEFAULT_NEXUS_DB_PATH,
): NixGenerationRecord[] {
  const db = ensureNixTables(dbPath);
  const rows = db
    .query(`SELECT * FROM nix_generations ORDER BY generation ASC`)
    .all() as Array<{
    generation: number;
    manifest_hash: string;
    store_paths_json: string;
    active: number;
    created_at: string;
  }>;
  return rows.map((r) => ({
    generation: r.generation,
    manifestHash: r.manifest_hash,
    storePaths: JSON.parse(r.store_paths_json) as string[],
    active: r.active === 1,
    createdAt: r.created_at,
  }));
}

export function listNixDerivations(
  dbPath = DEFAULT_NEXUS_DB_PATH,
): NixStoreEntry[] {
  const db = ensureNixTables(dbPath);
  const rows = db
    .query(`SELECT * FROM nix_derivations ORDER BY name ASC`)
    .all() as Array<{
    drv_hash: string;
    virtual_store_path: string;
    host_store_path: string;
    name: string;
    version: string;
    system: string;
    tier: NixDerivationInput["tier"];
    language: NixDerivationInput["language"];
    upstream_url: string | null;
    created_at: string;
  }>;
  return rows.map((r) => ({
    drvHash: r.drv_hash,
    virtualStorePath: r.virtual_store_path,
    hostStorePath: r.host_store_path,
    name: r.name,
    version: r.version,
    system: r.system,
    tier: r.tier,
    language: r.language,
    upstreamUrl: r.upstream_url ?? undefined,
    createdAt: r.created_at,
  }));
}

export function garbageCollectNixStore(options?: {
  storeRoot?: string;
  dbPath?: string;
}): { removedCount: number; keptCount: number } {
  const db = ensureNixTables(options?.dbPath);
  const storeRoot = options?.storeRoot ?? DEFAULT_NIX_STORE_ROOT;
  const activeGen = listNixGenerations(options?.dbPath).find((g) => g.active);
  const liveVirtual = new Set(activeGen?.storePaths ?? []);

  const allDrvs = listNixDerivations(options?.dbPath);
  let removedCount = 0;
  let keptCount = 0;
  for (const drv of allDrvs) {
    if (liveVirtual.size > 0 && !liveVirtual.has(drv.virtualStorePath)) {
      if (existsSync(drv.hostStorePath)) {
        rmSync(drv.hostStorePath, { recursive: true, force: true });
      }
      db.query(`DELETE FROM nix_derivations WHERE drv_hash = ?1`).run(
        drv.drvHash,
      );
      removedCount++;
    } else {
      keptCount++;
    }
  }
  if (existsSync(storeRoot)) {
    for (const d of readdirSync(storeRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const vPath = `/nix/store/${d.name}`;
      if (liveVirtual.size > 0 && !liveVirtual.has(vPath)) {
        rmSync(join(storeRoot, d.name), { recursive: true, force: true });
        removedCount++;
      }
    }
  }
  return { removedCount, keptCount };
}

export function classifyAphrodyDevRepositories(
  jsonlPath = "C:/src/var/aphrody-dev-repos.jsonl",
): AphrodyRepoClassification[] {
  let text = "";
  if (existsSync(jsonlPath)) {
    const rawBuf = readFileSync(jsonlPath);
    if (rawBuf.length >= 2 && rawBuf[0] === 0xff && rawBuf[1] === 0xfe) {
      text = new TextDecoder("utf-16le").decode(rawBuf);
    } else if (rawBuf.length >= 2 && rawBuf[0] === 0xfe && rawBuf[1] === 0xff) {
      text = new TextDecoder("utf-16be").decode(rawBuf);
    } else {
      text = new TextDecoder("utf-8").decode(rawBuf);
    }
    text = text.replace(/^\uFEFF/, "");
  }
  const rawLines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("{"));

  const parsed: Array<{
    name: string;
    html_url: string;
    description?: string | null;
  }> = rawLines.map((l) => JSON.parse(l));

  return parsed.map((repo) => {
    const n = repo.name.toLowerCase();
    const desc = stripEmojis(repo.description ?? `${repo.name} sovereign fork`);

    if (
      [
        "nixos-wsl",
        "coreutils",
        "brush",
        "fish-shell",
        "litebox",
        "asterinas",
        "boxedwine64",
        "chwd",
        "eac-extractor-utility",
      ].includes(n)
    ) {
      return {
        name: repo.name,
        htmlUrl: repo.html_url,
        description: desc,
        domain: "posix-nix-kernel",
        primaryStack: n === "boxedwine64" ? "C++ / WASM" : "Rust 2024",
        distilledRole:
          "POSIX/Unix shell, coreutils, library-OS sandbox & NixOS declarative store",
      };
    }

    if (
      [
        "bun",
        "burn",
        "cubecl",
        "mistral.rs",
        "models.dev",
        "jan",
        "maki",
        "agents-cli",
        "agent-desktop",
        "agent-browser",
        "transcribe.cpp",
        "hex",
        "strobe",
      ].includes(n)
    ) {
      return {
        name: repo.name,
        htmlUrl: repo.html_url,
        description: desc,
        domain: "ai-llm-compute",
        primaryStack:
          n === "bun" || n === "models.dev" || n === "agents-cli"
            ? "TypeScript (Bun/Vercel) + Rust/Zig"
            : n === "transcribe.cpp"
              ? "C/C++ ggml CUDA sm_89"
              : "Rust Fat-LTO + WebGPU/CUDA",
        distilledRole:
          "LLM/STT inference, WebGPU/CUDA compute, Computer-Use FFI & telemetry",
      };
    }

    if (["sst", "opentunnel", "lore"].includes(n)) {
      return {
        name: repo.name,
        htmlUrl: repo.html_url,
        description: desc,
        domain: "cloud-edge-infra",
        primaryStack: "TypeScript / Go / Rust",
        distilledRole: "Cloud/Edge IaC, secure tunneling & next-gen VCS",
      };
    }

    return {
      name: repo.name,
      htmlUrl: repo.html_url,
      description: desc,
      domain: "ui-terminal-editor",
      primaryStack:
        n === "mochi-desktop" ? "Python (uv)" : "Rust + WebGPU/GPUI",
      distilledRole:
        "GPU terminal, Tree-sitter AST, modal/IDE editor & Wayland/M3 shell",
    };
  });
}

export function generateNixFlakeAndVendorDistillation(options?: {
  aiOsDir?: string;
  dbPath?: string;
}): {
  flakeNixPath: string;
  vendorMatrixPath: string;
  aphrodyCatalogPath: string;
  installPs1Path: string;
  installShPath: string;
  activeGeneration: NixGenerationRecord;
  aphrodyRepoCount: number;
} {
  const aiOsDir = resolve(options?.aiOsDir ?? "C:/src/packages/ai-os");
  const distilledDir = join(aiOsDir, "distilled");
  mkdirSync(join(distilledDir, "installers"), { recursive: true });
  mkdirSync(join(distilledDir, "manifests"), { recursive: true });

  const aphrodyRepos = classifyAphrodyDevRepositories();
  const aphrodyCatalogPath = join(distilledDir, "aphrody-dev-catalog.json");
  writeFileSafeUserspace(
    aphrodyCatalogPath,
    `${JSON.stringify(aphrodyRepos, null, 2)}\n`,
  );

  // Realize core Nix derivations representing the objective tiered stack
  const coreDerivations: NixDerivationInput[] = [
    {
      name: "aios-wasm-kernel",
      version: "2.1.0",
      tier: "tier1-rust-bun",
      language: "wasm32-wgsl",
      upstreamUrl: "https://github.com/aphrody-dev/burn",
      builderScript: "cargo build --target wasm32-unknown-unknown --release",
    },
    {
      name: "aios-posix-coreutils",
      version: "2.1.0",
      tier: "tier1-rust-bun",
      language: "rust",
      upstreamUrl: "https://github.com/aphrody-dev/coreutils",
      builderScript: "cargo build --release -p unix-uutils",
    },
    {
      name: "aios-brush-justbash",
      version: "2.1.0",
      tier: "tier1-rust-bun",
      language: "typescript-bun",
      upstreamUrl: "https://github.com/aphrody-dev/brush",
      builderScript: "bun build --compile src/cli.ts",
    },
    {
      name: "aios-cuda-sm89-kernel",
      version: "13.4.0",
      tier: "tier2-proven-accelerator",
      language: "cuda-cpp",
      upstreamUrl: "https://github.com/ggml-org/llama.cpp",
      builderScript: "nvcc -arch=sm_89 -O3 --shared -o sovereign_cuda_sm89.dll",
    },
    {
      name: "aios-zig-simd-wasm",
      version: "0.15.0",
      tier: "tier2-proven-accelerator",
      language: "zig",
      upstreamUrl: "https://github.com/aphrody-dev/bun",
      builderScript: "zig build-exe -target wasm32-freestanding -O ReleaseFast",
    },
    {
      name: "aios-astral-uv-bridge",
      version: "0.9.0",
      tier: "tier2-proven-accelerator",
      language: "python-uv",
      upstreamUrl: "https://github.com/astral-sh/uv",
      builderScript: "uv sync --frozen",
    },
  ];

  const entries = coreDerivations.map((d) =>
    realizeNixDerivation(d, { dbPath: options?.dbPath }),
  );
  const activeGeneration = switchNixGeneration(entries, options?.dbPath);

  // 1. Write NixOS flake.nix (compatible with NixOS & aphrody-dev/NixOS-WSL)
  const flakeNixPath = join(aiOsDir, "flake.nix");
  const flakeNix = `{
  description = "Sovereign AI-OS: Cross-Platform Bun + Rust + WASM32 + WebGPU + POSIX/Nix Control Plane";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay.url = "github:oxalica/rust-overlay";
  };

  outputs = { self, nixpkgs, rust-overlay }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in {
      packages = forAllSystems (system:
        let
          overlays = [ (import rust-overlay) ];
          pkgs = import nixpkgs { inherit system overlays; };
          rustToolchain = pkgs.rust-bin.stable.latest.default.override {
            targets = [ "wasm32-unknown-unknown" "wasm32-wasip1" ];
          };
        in {
          default = pkgs.stdenv.mkDerivation {
            pname = "ai-os";
            version = "2.1.0";
            src = ./.;
            nativeBuildInputs = [ pkgs.bun rustToolchain pkgs.zig pkgs.ripgrep pkgs.uutils-coreutils-noprefix ];
            buildPhase = ''
              cd crates/aios-wasm-kernel
              cargo build --target wasm32-unknown-unknown --release
              cd ../..
              bun build --compile --minify src/cli.ts --outfile ai-os
            '';
            installPhase = ''
              mkdir -p $out/bin $out/share/ai-os
              cp ai-os $out/bin/ai-os
              cp crates/aios-wasm-kernel/target/wasm32-unknown-unknown/release/aios_wasm_kernel.wasm $out/share/ai-os/
            '';
          };
        });
    };
}
`;
  writeFileSafeUserspace(flakeNixPath, flakeNix);

  // 2. Write Polyglot Clean Dependency Manifests (replacing raw vendor bloat!)
  writeFileSafeUserspace(
    join(distilledDir, "manifests", "Cargo.distilled.toml"),
    `# Tier-1 Rust & WASM32 Dependencies (replaces raw vendor checkouts)
[workspace.dependencies]
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
blake3 = "1.8"
ignore = "0.4"
grep-regex = "0.1"
tree-sitter = "0.25"
uucore = "0.0.30"
wgpu = "25.0"
windows-sys = "0.61"
`,
  );

  writeFileSafeUserspace(
    join(distilledDir, "manifests", "pyproject.uv.toml"),
    `[project]
name = "ai-os-tier2-science"
version = "2.1.0"
requires-python = ">=3.12"
dependencies = [
  "jax>=0.5.0",
  "optax>=0.2.4",
  "safetensors>=0.5.0",
  "numpy>=2.2.0",
]
`,
  );

  writeFileSafeUserspace(
    join(distilledDir, "manifests", "build.zig.zon"),
    `.{
    .name = .ai_os_zig_simd,
    .version = "2.1.0",
    .minimum_zig_version = "0.14.0",
    .paths = .{ "zig" },
}
`,
  );

  writeFileSafeUserspace(
    join(distilledDir, "manifests", "go.mod"),
    `module github.com/aphrody-dev/ai-os/infra-oci

go 1.24
`,
  );

  // 3. Write Cross-Platform Declarative Installers
  const installPs1Path = join(distilledDir, "installers", "install-stack.ps1");
  writeFileSafeUserspace(
    installPs1Path,
    `# Sovereign AI-OS Declarative Installer (Windows Userspace Only - Never touches System32)
$ErrorActionPreference = "Stop"
$BinDir = Join-Path $HOME ".local\\bin"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Push-Location "C:\\src\\packages\\ai-os\\crates\\aios-wasm-kernel"
cargo build --target wasm32-unknown-unknown --release
Pop-Location
Push-Location "C:\\src\\packages\\ai-os"
bun build --compile --minify src/cli.ts --outfile (Join-Path $BinDir "ai-os.exe")
Pop-Location
Write-Output "Installed single cross-platform + WASM/WebGPU binary: $BinDir\\ai-os.exe"
`,
  );

  const installShPath = join(distilledDir, "installers", "install-stack.sh");
  writeFileSafeUserspace(
    installShPath,
    `#!/usr/bin/env sh
set -eu
BIN_DIR="\${HOME}/.local/bin"
mkdir -p "\${BIN_DIR}"
(cd crates/aios-wasm-kernel && cargo build --target wasm32-unknown-unknown --release)
bun build --compile --minify src/cli.ts --outfile "\${BIN_DIR}/ai-os"
echo "Installed single cross-platform + WASM/WebGPU binary: \${BIN_DIR}/ai-os"
`,
  );

  // 4. Write Distilled Vendor & Ecosystem Matrix Doc
  const vendorMatrixPath = join(distilledDir, "VENDOR_AND_APHRODY_MATRIX.md");
  const tableRows = aphrodyRepos
    .map(
      (r) =>
        `| \`aphrody-dev/${r.name}\` | ${r.domain} | ${r.primaryStack} | ${r.distilledRole} |`,
    )
    .join("\n");

  const matrixMd = `# Sovereign AI-OS Vendor Distillation & Stack Selection Matrix

## 1. Selection Law (Rust & Vercel/Bun TypeScript First -> Empirical Promotion)
1. **Tier 1 (Default Mandatory)**: **Rust 2024 (\`Cargo\` + \`wasm32-unknown-unknown\`)** and **TypeScript (\`Bun v1.4.4\` + Vercel Edge/WebGPU compatible)** with zero npm bloat.
2. **Tier 2 (Promoted ONLY when empirically faster/better)**:
   - **C/C++ CUDA 13.4 \`sm_89\`** (\`sovereign_cuda_sm89.dll\`, \`llama.cpp\`, \`transcribe.cpp\`): Promoted for dense/quantized GPU tensor compute (\`> 15x\` over CPU).
   - **Zig \`-O ReleaseFast\`**: Promoted for freestanding zero-libc WASM/C-ABI shims (7.7 KB WASM binary).
   - **Python \`uv\` + PyO3**: Promoted strictly for JAX/Optax/Tunix DeepMind research notebooks.
   - **Go 1.27**: Promoted strictly for OCI/WireGuard/MASQUE mesh (\`infra_go.dll\`, \`src-deploy\`).
   - **.NET 10/11 NativeAOT**: Promoted strictly when bridging Windows WinUI / \`hostfxr\` assemblies (\`n2b_dotnet\`).

## 2. Distilled Vendor Ecosystems (Vendor -> Docs + Refs + Manifests + Skills)
- **Vercel & Vercel-Labs** (\`third_party/labs\`): Distilled into \`src/protocols/fusion-specs.ts\` (Vercel UIMessageStream v1 SSE) and \`src/posix/unix-os.ts\` (\`just-bash\` virtual POSIX shell).
- **Google DeepMind & Google** (\`third_party/google-ecosystem\`): Distilled into keyless Vertex AI grounding, A2A JSON-RPC, Gemma 4 chat/RMSNorm kernels, and progressive-disclosure skill packs.
- **OpenAI & Llama/ggml** (\`third_party/ai-ecosystem\`): Distilled into \`/v1/chat/completions\`, \`/v1/responses\`, GGUF binary header parser, and \`llama-server\` / \`r3d\` federation.
- **Microsoft, Cloudflare & uutils** (\`third_party/microsoft\`, \`third_party/cloudflare\`, \`crates/unix\`): Distilled into \`AiPosixOs\` (\`litebox\` capability mounts + \`uutils\` coreutils + \`workerd\` WASM/WebGPU edge compatibility).

## 3. Complete Scan of \`github.com/aphrody-dev\` (${aphrodyRepos.length} Repositories)

| Repository | Domain | Primary Stack | Distilled Integration in \`ai-os\` |
| --- | --- | --- | --- |
${tableRows}
`;
  writeFileSafeUserspace(vendorMatrixPath, matrixMd);

  return {
    flakeNixPath: flakeNixPath.replace(/\\/g, "/"),
    vendorMatrixPath: vendorMatrixPath.replace(/\\/g, "/"),
    aphrodyCatalogPath: aphrodyCatalogPath.replace(/\\/g, "/"),
    installPs1Path: installPs1Path.replace(/\\/g, "/"),
    installShPath: installShPath.replace(/\\/g, "/"),
    activeGeneration,
    aphrodyRepoCount: aphrodyRepos.length,
  };
}

export const distillAphrodyAndVendorEcosystem =
  generateNixFlakeAndVendorDistillation;
