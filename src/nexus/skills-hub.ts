import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DEFAULT_NEXUS_DB_PATH, openNexusDb } from "./brain-memory.ts";
import { stripEmojis, writeFileSafeUserspace } from "./security.ts";

export interface UnifiedSkillRecord {
  id: string;
  name: string;
  description: string;
  collection: string;
  path: string;
  sizeBytes: number;
}

export interface SkillCollectionPack {
  id: string;
  title: string;
  description: string;
  defaultEnabled: boolean;
  mcpToolsUnlocked: string[];
  sourceDirs: string[];
  umbrellaSkillName: string;
}

export const SKILL_COLLECTION_PACKS: readonly SkillCollectionPack[] = [
  {
    id: "os-minimal",
    title: "Minimal OS & Computer-Use Core (Default)",
    description:
      "Ultra-lean atomic OS tools (read, write, edit, bash, desktop_snapshot, desktop_action, browser_navigate) for maximum context economy.",
    defaultEnabled: true,
    mcpToolsUnlocked: [
      "desktop_snapshot",
      "desktop_action",
      "browser_navigate",
      "browser_a11y_tree",
      "monorepo_exec",
      "skills_search",
    ],
    sourceDirs: [
      "C:/src/third_party/agent-desktop/skills",
      "C:/src/third_party/agent-browser/skills",
    ],
    umbrellaSkillName: "os-minimal-computer-use",
  },
  {
    id: "google-cloud",
    title: "Google Cloud & Developer Knowledge (189+ Official Skills)",
    description:
      "Official google/skills catalog (GKE, Cloud Run, BigQuery, Spanner, Vertex AI, AlloyDB, IAM, Firebase) + guarded gcloud CLI & Developer Knowledge.",
    defaultEnabled: false,
    mcpToolsUnlocked: ["google_cloud"],
    sourceDirs: ["C:/src/third_party/google-ecosystem/google-skills"],
    umbrellaSkillName: "google-cloud-official-catalog",
  },
  {
    id: "google-workspace",
    title: "Google Workspace gws Suite (95 Official Skills)",
    description:
      "Official googleworkspace/cli skills for Drive, Docs, Sheets, Gmail, Calendar, Chat, Slides, Tasks, and People via gws.exe.",
    defaultEnabled: false,
    mcpToolsUnlocked: ["google_workspace"],
    sourceDirs: ["C:/src/third_party/google-ecosystem/googleworkspace-cli"],
    umbrellaSkillName: "google-workspace-gws-suite",
  },
  {
    id: "gemini-multimodal",
    title: "Gemini API, AI Studio, Live API & Omni Video",
    description:
      "Official google-gemini/gemini-skills, Gemini API SDKs, Live 3.8 bidirectional streaming, Omni 1.2 Flash video, and Grounded Google Search.",
    defaultEnabled: false,
    mcpToolsUnlocked: ["google_search", "docs_context"],
    sourceDirs: ["C:/src/third_party/google-ecosystem/gemini-skills"],
    umbrellaSkillName: "gemini-ai-studio-multimodal",
  },
  {
    id: "android",
    title: "Android, Jetpack Compose, Kotlin & Android XR (36 Official Skills)",
    description:
      "Official android/skills covering Jetpack Compose, Coroutines, Architecture, Gradle, Play Integrity, Perfetto, and Android XR.",
    defaultEnabled: false,
    mcpToolsUnlocked: ["docs_context"],
    sourceDirs: ["C:/src/third_party/google-ecosystem/android-skills"],
    umbrellaSkillName: "android-official-platform",
  },
  {
    id: "google-labs",
    title: "Google Labs Stitch, DESIGN.md, Jules & Stax (22 Official Skills)",
    description:
      "Official google-labs-code skills for Stitch UI generation, DESIGN.md system synthesis, Jules autonomous tasks, and Stax evaluation.",
    defaultEnabled: true,
    mcpToolsUnlocked: ["design_figma"],
    sourceDirs: [
      "C:/src/third_party/google-ecosystem/stitch-skills",
      "C:/src/third_party/google-ecosystem/jules-skills",
      "C:/src/third_party/google-ecosystem/design-md",
    ],
    umbrellaSkillName: "google-labs-stitch-jules-design",
  },
  {
    id: "deepmind-science",
    title: "Google DeepMind JAX, Gemma 4, Optax, Tunix & NotebookLM",
    description:
      "DeepMind research workflows, Gemma 4 local/CUDA sm_89/JAX/Torch training & inference, Optax/RLax, and Open NotebookLM grounded synthesis.",
    defaultEnabled: false,
    mcpToolsUnlocked: ["hardware_cuda", "brain_memory_soul"],
    sourceDirs: ["C:/src/packages/agy"],
    umbrellaSkillName: "deepmind-gemma4-notebooklm",
  },
  {
    id: "pro-max-fullstack",
    title:
      "Fullstack Pro-Max (Lighthouse, CWV, Stitch, Figma, REA, Replica, 3D, Humanizer, Deploy)",
    description:
      "Complete Bun + Rust fullstack builder pack: Modern Web Guidelines, Lighthouse 100 & Web Vitals (wck), Figma/M3 (gds), REA/Ghidra/Replica (n2b), UI/UX Pro Max, 3D WebGPU/WGSL Pro Max, Impeccable, Humanizer, Cloudflare + Vercel + src-deploy.",
    defaultEnabled: true,
    mcpToolsUnlocked: [
      "design_figma",
      "n2b_rea",
      "github_forge",
      "docs_context",
      "ai_triad",
    ],
    sourceDirs: ["C:/src/.agents/skills", "C:/src/third_party/labs"],
    umbrellaSkillName: "pro-max-fullstack-builder",
  },
];

function extractFrontmatter(
  raw: string,
  fallbackName: string,
): { name: string; description: string } {
  let name = fallbackName;
  let description = "";
  if (raw.startsWith("---")) {
    const endIdx = raw.indexOf("\n---", 3);
    if (endIdx > 0) {
      const yamlBlock = raw.slice(4, endIdx);
      for (const line of yamlBlock.split(/\r?\n/)) {
        const mName = /^name:\s*(.+)$/.exec(line);
        if (mName?.[1]) name = mName[1].trim().replace(/^['"]|['"]$/g, "");
        const mDesc = /^description:\s*(.+)$/.exec(line);
        if (mDesc?.[1])
          description = mDesc[1].trim().replace(/^['"]|['"]$/g, "");
      }
    }
  }
  if (!description) {
    const firstLine = raw
      .replace(/^---[\s\S]*?---\s*/, "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#"));
    description = firstLine ? firstLine.slice(0, 220) : `${name} skill`;
  }
  return {
    name: stripEmojis(name),
    description: stripEmojis(description).slice(0, 260),
  };
}

let cachedCatalog: { expiresAt: number; items: UnifiedSkillRecord[] } | null =
  null;

export function scanAllEcosystemSkills(
  forceRefresh = false,
): UnifiedSkillRecord[] {
  const now = Date.now();
  if (!forceRefresh && cachedCatalog && cachedCatalog.expiresAt > now) {
    return cachedCatalog.items;
  }

  const home = homedir();
  const roots: Array<{ collection: string; dir: string }> = [
    ...SKILL_COLLECTION_PACKS.flatMap((pack) =>
      pack.sourceDirs.map((dir) => ({ collection: pack.id, dir })),
    ),
    { collection: "user-global", dir: join(home, ".gemini", "skills") },
    {
      collection: "user-plugins",
      dir: join(home, ".gemini", "config", "plugins"),
    },
  ];

  const skip = new Set([
    ".git",
    "node_modules",
    "target",
    ".venv",
    "dist",
    "build",
  ]);
  const seen = new Set<string>();
  const out: UnifiedSkillRecord[] = [];

  for (const r of roots) {
    if (!existsSync(r.dir)) continue;
    const visit = (dir: string, depth: number) => {
      if (depth > 7) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (skip.has(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          visit(full, depth + 1);
        } else if (e.isFile() && e.name === "SKILL.md") {
          const norm = resolve(full).replace(/\\/g, "/");
          if (seen.has(norm)) continue;
          seen.add(norm);
          try {
            const st = statSync(full);
            const raw = readFileSync(full, "utf8");
            const folder = basename(dirname(full));
            const fm = extractFrontmatter(raw, folder);
            out.push({
              id: `${r.collection}:${fm.name}`,
              name: fm.name,
              description: fm.description,
              collection: r.collection,
              path: norm,
              sizeBytes: st.size,
            });
          } catch {
            // Ignore unreadable file
          }
        }
      }
    };
    visit(r.dir, 0);
  }

  out.sort((a, b) => a.id.localeCompare(b.id));
  cachedCatalog = { expiresAt: now + 45_000, items: out };
  return out;
}

export function searchUnifiedSkills(
  query: string,
  options?: { collection?: string; limit?: number },
): UnifiedSkillRecord[] {
  const all = scanAllEcosystemSkills();
  const q = query.trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, options?.limit ?? 25));
  return all
    .filter((s) => {
      if (options?.collection && s.collection !== options.collection) {
        return false;
      }
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.collection.toLowerCase().includes(q) ||
        s.path.toLowerCase().includes(q)
      );
    })
    .slice(0, limit);
}

export function readUnifiedSkillContent(nameOrPath: string): {
  found: boolean;
  skill?: UnifiedSkillRecord;
  content?: string;
} {
  const all = scanAllEcosystemSkills();
  const norm = nameOrPath.replace(/\\/g, "/").toLowerCase();
  const match = all.find(
    (s) =>
      s.name.toLowerCase() === norm ||
      s.id.toLowerCase() === norm ||
      s.path.toLowerCase() === norm,
  );
  if (!match || !existsSync(match.path)) {
    return { found: false };
  }
  return {
    found: true,
    skill: match,
    content: stripEmojis(readFileSync(match.path, "utf8")),
  };
}

export function listActiveCollections(dbPath = DEFAULT_NEXUS_DB_PATH): Array<
  SkillCollectionPack & {
    installed: boolean;
    enabled: boolean;
    skillCount: number;
  }
> {
  const db = openNexusDb(dbPath);
  const rows = db
    .query(`SELECT collection_id, enabled FROM active_collections`)
    .all() as Array<{ collection_id: string; enabled: number }>;
  const map = new Map(rows.map((r) => [r.collection_id, r.enabled === 1]));
  const allSkills = scanAllEcosystemSkills();

  return SKILL_COLLECTION_PACKS.map((pack) => {
    const installed = map.has(pack.id) || pack.defaultEnabled;
    const enabled = map.get(pack.id) ?? pack.defaultEnabled;
    const skillCount = allSkills.filter((s) => s.collection === pack.id).length;
    return {
      ...pack,
      installed,
      enabled,
      skillCount,
    };
  });
}

export function installSkillCollection(
  collectionId: string,
  options?: { dbPath?: string; skillsOutRoot?: string },
): {
  ok: boolean;
  collection?: SkillCollectionPack;
  umbrellaSkillPath?: string;
  indexedSubSkills: number;
  error?: string;
} {
  const pack = SKILL_COLLECTION_PACKS.find((p) => p.id === collectionId);
  if (!pack) {
    return {
      ok: false,
      indexedSubSkills: 0,
      error: `Unknown collection '${collectionId}'. Valid packs: ${SKILL_COLLECTION_PACKS.map((p) => p.id).join(", ")}`,
    };
  }

  const db = openNexusDb(options?.dbPath);
  db.query(
    `INSERT OR REPLACE INTO active_collections (collection_id, installed_at, enabled) VALUES (?1, ?2, 1)`,
  ).run(pack.id, new Date().toISOString());

  const subSkills = scanAllEcosystemSkills().filter(
    (s) => s.collection === pack.id,
  );
  const outRoot = options?.skillsOutRoot ?? "C:\\src\\.agents\\skills";
  const umbrellaPath = join(outRoot, pack.umbrellaSkillName, "SKILL.md");

  const topEntries = subSkills
    .slice(0, 45)
    .map(
      (s) =>
        `- **\`${s.name}\`**: ${s.description.slice(0, 130)} (\`${s.path}\`)`,
    )
    .join("\n");

  const md = `---
name: ${pack.umbrellaSkillName}
description: ${pack.description}
---

# ${pack.title}

This progressive-disclosure umbrella skill routes to **${subSkills.length}** official skills in collection \`${pack.id}\`.
Use the unified \`ai-os\` MCP tool \`skills_search\` (or \`agy collections inspect ${pack.id}\`) to load any sub-skill on demand without bloating idle context.

## Unlocked Unified MCP Domains
${pack.mcpToolsUnlocked.map((t) => `- \`${t}\``).join("\n")}

## Indexed Official Sub-Skills (${Math.min(45, subSkills.length)} of ${subSkills.length} shown)
${topEntries || "- Native built-in pack."}
`;

  writeFileSafeUserspace(umbrellaPath, md);
  return {
    ok: true,
    collection: pack,
    umbrellaSkillPath: umbrellaPath.replace(/\\/g, "/"),
    indexedSubSkills: subSkills.length,
  };
}

export function removeSkillCollection(
  collectionId: string,
  dbPath = DEFAULT_NEXUS_DB_PATH,
): { ok: boolean; collectionId: string; note?: string } {
  if (collectionId === "os-minimal") {
    return {
      ok: true,
      collectionId,
      note: "os-minimal remains active as the mandatory baseline OS toolset.",
    };
  }
  const db = openNexusDb(dbPath);
  db.query(
    `UPDATE active_collections SET enabled = 0 WHERE collection_id = ?1`,
  ).run(collectionId);
  return { ok: true, collectionId };
}

export function resetToMinimalCollectionsOnly(
  dbPath = DEFAULT_NEXUS_DB_PATH,
): void {
  const db = openNexusDb(dbPath);
  db.exec(
    `UPDATE active_collections SET enabled = 0 WHERE collection_id != 'os-minimal'`,
  );
  const nowIso = new Date().toISOString();
  db.query(
    `INSERT OR REPLACE INTO active_collections (collection_id, installed_at, enabled) VALUES ('os-minimal', ?1, 1)`,
  ).run(nowIso);
  db.query(
    `INSERT OR REPLACE INTO global_settings (key, value, updated_at) VALUES ('default_mode', 'minimal', ?1)`,
  ).run(nowIso);
}

export const DEFAULT_GLOBAL_DESIGN_COLLECTIONS: readonly string[] = [
  "os-minimal",
  "pro-max-fullstack",
  "google-labs",
  "gemini-multimodal",
  "google-cloud",
];

export function enableFullDesignModeGlobal(options?: {
  dbPath?: string;
  skillsOutRoot?: string;
  modeStatePath?: string;
}): {
  ok: true;
  mode: "full-design";
  activeCollections: string[];
  umbrellaSkillsWritten: string[];
  modeStatePath: string;
} {
  const dbPath = options?.dbPath ?? DEFAULT_NEXUS_DB_PATH;
  const db = openNexusDb(dbPath);
  const nowIso = new Date().toISOString();
  const umbrellaSkillsWritten: string[] = [];

  for (const cid of DEFAULT_GLOBAL_DESIGN_COLLECTIONS) {
    const res = installSkillCollection(cid, {
      dbPath,
      skillsOutRoot: options?.skillsOutRoot,
    });
    if (res.umbrellaSkillPath) {
      umbrellaSkillsWritten.push(res.umbrellaSkillPath);
    }
  }

  db.query(
    `INSERT OR REPLACE INTO global_settings (key, value, updated_at) VALUES ('default_mode', 'full-design', ?1)`,
  ).run(nowIso);

  const modeStatePath =
    options?.modeStatePath ?? "C:/src/var/agy-mode-state.json";
  const statePayload = {
    mode: "fullstack",
    globalDesignMode: "full-design",
    domainFocus: "full-design-pro-max",
    ephemeralUnrecorded: false,
    elevatedUserspaceNoSandbox: false,
    system32Protected: true,
    gates: [
      "agent-browser",
      "lighthouse-100",
      "modern-web-guidelines",
      "core-web-vitals",
      "humanizer",
      "impeccable",
      "ui-ux-pro-max",
      "3d-pro-max",
      "gds-design-first",
      "wck-100",
    ],
    activeCollections: [...DEFAULT_GLOBAL_DESIGN_COLLECTIONS],
    updatedAt: nowIso,
  };
  writeFileSafeUserspace(
    modeStatePath,
    `${JSON.stringify(statePayload, null, 2)}\n`,
  );

  return {
    ok: true,
    mode: "full-design",
    activeCollections: [...DEFAULT_GLOBAL_DESIGN_COLLECTIONS],
    umbrellaSkillsWritten,
    modeStatePath,
  };
}

export function getAiOsGlobalMode(dbPath = DEFAULT_NEXUS_DB_PATH): {
  mode: "full-design" | "minimal";
  activeCollections: string[];
} {
  const db = openNexusDb(dbPath);
  const row = db
    .query(`SELECT value FROM global_settings WHERE key = 'default_mode'`)
    .get() as { value: string } | null;
  const active = listActiveCollections(dbPath)
    .filter((c) => c.enabled)
    .map((c) => c.id);
  return {
    mode: row?.value === "minimal" ? "minimal" : "full-design",
    activeCollections: active,
  };
}
