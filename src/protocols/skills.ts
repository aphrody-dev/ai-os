import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  ecosystem:
    | "google-deepmind"
    | "vercel-labs"
    | "anthropic-claude"
    | "opencode"
    | "agent-browser"
    | "agent-desktop"
    | "sovereign-monorepo";
  path: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface HookEntry {
  id: string;
  ecosystem: SkillEntry["ecosystem"];
  path: string;
  events: string[];
  sizeBytes: number;
  rawPreview: Record<string, unknown>;
}

export interface SkillsAndHooksRegistry {
  scannedAt: string;
  totalSkills: number;
  totalHooks: number;
  byEcosystem: Record<string, { skills: number; hooks: number }>;
  skills: SkillEntry[];
  hooks: HookEntry[];
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function getScanRoots(): Array<{
  ecosystem: SkillEntry["ecosystem"];
  dir: string;
}> {
  const home = homedir();
  return [
    { ecosystem: "google-deepmind", dir: join(home, ".gemini", "skills") },
    {
      ecosystem: "google-deepmind",
      dir: join(home, ".gemini", "config", "plugins"),
    },
    {
      ecosystem: "google-deepmind",
      dir: "C:/src/third_party/google-ecosystem",
    },
    { ecosystem: "vercel-labs", dir: "C:/src/labs" },
    { ecosystem: "vercel-labs", dir: "C:/src/third_party/labs" },
    { ecosystem: "anthropic-claude", dir: join(home, ".claude") },
    { ecosystem: "opencode", dir: join(home, ".config", "opencode") },
    { ecosystem: "agent-browser", dir: "C:/src/agent-browser/skills" },
    {
      ecosystem: "agent-browser",
      dir: "C:/src/third_party/agent-browser/skills",
    },
    { ecosystem: "agent-desktop", dir: "C:/src/agent-desktop/skills" },
    {
      ecosystem: "agent-desktop",
      dir: "C:/src/third_party/agent-desktop/skills",
    },
    { ecosystem: "sovereign-monorepo", dir: "C:/src/.agents" },
  ];
}

function parseSkillFrontmatter(
  content: string,
  fallbackName: string,
): {
  name: string;
  description: string;
} {
  let name = fallbackName;
  let description = "";
  if (content.startsWith("---")) {
    const endIdx = content.indexOf("\n---", 3);
    if (endIdx > 0) {
      const yamlChunk = content.slice(4, endIdx);
      try {
        const parsed = Bun.YAML.parse(yamlChunk) as Record<
          string,
          unknown
        > | null;
        if (parsed && typeof parsed === "object") {
          if (
            typeof parsed.name === "string" &&
            parsed.name.trim().length > 0
          ) {
            name = parsed.name.trim();
          }
          if (
            typeof parsed.description === "string" &&
            parsed.description.trim().length > 0
          ) {
            description = parsed.description.trim();
          }
        }
      } catch {
        for (const line of yamlChunk.split(/\r?\n/)) {
          const mName = /^name:\s*(.+)$/.exec(line);
          if (mName?.[1]) name = mName[1].trim().replace(/^['"]|['"]$/g, "");
          const mDesc = /^description:\s*(.+)$/.exec(line);
          if (mDesc?.[1])
            description = mDesc[1].trim().replace(/^['"]|['"]$/g, "");
        }
      }
    }
  }
  if (!description) {
    const firstPara = content
      .replace(/^---[\s\S]*?---\s*/, "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#"));
    description = firstPara ? firstPara.slice(0, 240) : `${name} skill`;
  }
  return { name, description };
}

function walkForSkillsAndHooks(
  rootDir: string,
  ecosystem: SkillEntry["ecosystem"],
  skillsOut: SkillEntry[],
  hooksOut: HookEntry[],
  seenPaths: Set<string>,
): void {
  if (!existsSync(rootDir)) return;
  const skip = new Set([
    "node_modules",
    ".git",
    "target",
    ".next",
    "dist",
    "cache",
  ]);

  function visit(dir: string, depth: number): void {
    if (depth > 9) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
      } else if (entry.isFile()) {
        const norm = normalizeSlashes(resolve(full));
        if (seenPaths.has(norm)) continue;

        if (entry.name === "SKILL.md") {
          seenPaths.add(norm);
          try {
            const st = statSync(full);
            const content = readFileSync(full, "utf8");
            const folderName = basename(dirname(full));
            const { name, description } = parseSkillFrontmatter(
              content,
              folderName,
            );
            skillsOut.push({
              id: `${ecosystem}:${name}`,
              name,
              description,
              ecosystem,
              path: norm,
              sizeBytes: st.size,
              updatedAt: st.mtime.toISOString(),
            });
          } catch {
            // ignore unreadable files
          }
        } else if (entry.name === "hooks.json") {
          seenPaths.add(norm);
          try {
            const st = statSync(full);
            const raw = JSON.parse(readFileSync(full, "utf8")) as Record<
              string,
              unknown
            >;
            const hooksObj = (
              raw.hooks && typeof raw.hooks === "object" ? raw.hooks : raw
            ) as Record<string, unknown>;
            const events = Object.keys(hooksObj);
            hooksOut.push({
              id: `${ecosystem}:${basename(dirname(full))}:hooks`,
              ecosystem,
              path: norm,
              events,
              sizeBytes: st.size,
              rawPreview: { events, topLevelKeys: Object.keys(raw) },
            });
          } catch {
            // ignore malformed JSON
          }
        }
      }
    }
  }

  visit(rootDir, 0);
}

let cachedRegistry: { expiresAt: number; data: SkillsAndHooksRegistry } | null =
  null;

export function buildSkillsAndHooksRegistry(
  forceRefresh = false,
): SkillsAndHooksRegistry {
  const now = Date.now();
  if (!forceRefresh && cachedRegistry && cachedRegistry.expiresAt > now) {
    return cachedRegistry.data;
  }

  const skills: SkillEntry[] = [];
  const hooks: HookEntry[] = [];
  const seenPaths = new Set<string>();
  const byEcosystem: Record<string, { skills: number; hooks: number }> = {};

  for (const root of getScanRoots()) {
    if (!byEcosystem[root.ecosystem]) {
      byEcosystem[root.ecosystem] = { skills: 0, hooks: 0 };
    }
    const beforeS = skills.length;
    const beforeH = hooks.length;
    walkForSkillsAndHooks(root.dir, root.ecosystem, skills, hooks, seenPaths);
    byEcosystem[root.ecosystem]!.skills += skills.length - beforeS;
    byEcosystem[root.ecosystem]!.hooks += hooks.length - beforeH;
  }

  skills.sort((a, b) => a.id.localeCompare(b.id));
  hooks.sort((a, b) => a.id.localeCompare(b.id));

  const data: SkillsAndHooksRegistry = {
    scannedAt: new Date().toISOString(),
    totalSkills: skills.length,
    totalHooks: hooks.length,
    byEcosystem,
    skills,
    hooks,
  };

  cachedRegistry = { expiresAt: now + 30_000, data };
  return data;
}

export function searchSkills(query: string, limit = 25): SkillEntry[] {
  const reg = buildSkillsAndHooksRegistry();
  const q = query.trim().toLowerCase();
  if (!q) return reg.skills.slice(0, limit);
  return reg.skills
    .filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.ecosystem.toLowerCase().includes(q) ||
        s.path.toLowerCase().includes(q),
    )
    .slice(0, limit);
}

export function handleSkillsRequest(url: URL): Response {
  const q = url.searchParams.get("q") ?? "";
  const ecosystem = url.searchParams.get("ecosystem");
  const refresh = url.searchParams.get("refresh") === "1";
  const reg = buildSkillsAndHooksRegistry(refresh);

  let filtered = q ? searchSkills(q, 500) : reg.skills;
  if (ecosystem) {
    filtered = filtered.filter((s) => s.ecosystem === ecosystem);
  }

  const readPath = url.searchParams.get("path");
  if (readPath) {
    const match = reg.skills.find(
      (s) => s.path === normalizeSlashes(readPath) || s.id === readPath,
    );
    if (!match || !existsSync(match.path)) {
      return Response.json({ error: "Skill not found" }, { status: 404 });
    }
    return Response.json({
      skill: match,
      content: readFileSync(match.path, "utf8"),
    });
  }

  return Response.json({
    scannedAt: reg.scannedAt,
    totalSkills: reg.totalSkills,
    matchedCount: filtered.length,
    byEcosystem: reg.byEcosystem,
    skills: filtered,
  });
}

export function handleHooksRequest(url: URL): Response {
  const refresh = url.searchParams.get("refresh") === "1";
  const ecosystem = url.searchParams.get("ecosystem");
  const reg = buildSkillsAndHooksRegistry(refresh);
  const filtered = ecosystem
    ? reg.hooks.filter((h) => h.ecosystem === ecosystem)
    : reg.hooks;

  return Response.json({
    scannedAt: reg.scannedAt,
    totalHooks: reg.totalHooks,
    matchedCount: filtered.length,
    byEcosystem: reg.byEcosystem,
    hooks: filtered,
  });
}
