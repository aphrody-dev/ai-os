// SKILL.md linter, ported from Hermes Agent tools/skill_linter.py (MIT, Nous Research). Rule ids kept identical.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type LintFinding = {
  severity: "error" | "warning";
  rule: string;
  message: string;
};

const SHELL_UTIL_TO_TOOL: Record<string, string> = {
  grep: "memory_search/read_file",
  rg: "read_file",
  cat: "read_file",
  head: "read_file",
  tail: "read_file",
  sed: "write_file",
  awk: "write_file",
};
const MARKETING = [
  "powerful",
  "comprehensive",
  "seamless",
  "advanced",
  "cutting-edge",
  "state-of-the-art",
  "revolutionary",
  "robust",
];
const FORBIDDEN_FILES = [
  "README.md",
  "CHANGELOG.md",
  "install.sh",
  ".env",
  ".env.example",
  ".gitignore",
];
const DESC_LIMIT = 1024;
const BODY_SOFT_BUDGET = 24_000;
const INCIDENT_REF_MIN = 4;
const INCIDENT_REF_PER_KCHAR = 0.5;
const MAX_REFERENCE_FILES = 60;

export function parseSkill(
  content: string,
): { front: Record<string, string>; body: string } | null {
  const m = content
    .replace(/\r\n/g, "\n")
    .match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const front: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) front[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "");
  }
  return { front, body: m[2]! };
}

export function lintContent(content: string, skillDir?: string): LintFinding[] {
  const out: LintFinding[] = [];
  const err = (rule: string, message: string) =>
    out.push({ severity: "error", rule, message });
  const warn = (rule: string, message: string) =>
    out.push({ severity: "warning", rule, message });
  const parsed = parseSkill(content);
  if (!parsed) {
    err(
      "frontmatter-missing",
      "SKILL.md must start with a YAML front matter block.",
    );
    return out;
  }
  const { front, body } = parsed;
  const name = front.name ?? "";
  if (!name) err("name-missing", "front matter has no name.");
  else if (!/^[a-z0-9_-]+$/.test(name))
    err(
      "name-format",
      `name '${name}' must be lowercase letters, digits, hyphens, underscores.`,
    );
  if (skillDir && name && name !== skillDir.split(/[\\/]/).pop())
    err("name-dir-mismatch", `name '${name}' does not match its directory.`);
  const desc = front.description ?? "";
  if (!desc) err("description-missing", "front matter has no description.");
  else if (desc.length > DESC_LIMIT)
    warn(
      "description-length",
      `description is ${desc.length} chars; index clips at ${DESC_LIMIT}.`,
    );
  const hits = MARKETING.filter((w) => desc.toLowerCase().includes(w));
  if (hits.length)
    warn(
      "description-marketing",
      `description contains marketing words ${hits.join(", ")}.`,
    );

  if (body.length > BODY_SOFT_BUDGET)
    warn(
      "oversized-body",
      `body is ${body.length} chars; move depth into references/.`,
    );
  const prose = body.replace(/```[\s\S]*?```/g, "");
  for (const [util, tool] of Object.entries(SHELL_UTIL_TO_TOOL)) {
    if (new RegExp(`\`${util}\\b`).test(prose))
      warn(
        "shell-utility-reference",
        `prose references \`${util}\`; name ${tool} instead.`,
      );
  }
  if (!/^#+\s+When to [Uu]se/m.test(body))
    warn("missing-section", "no '## When to Use' section.");
  const refs = (prose.match(/(?:#\d{2,}|\bPR\s*\d+|\bissue\s*\d+)/gi) ?? [])
    .length;
  if (
    refs >= INCIDENT_REF_MIN &&
    refs / Math.max(1, prose.length / 1000) >= INCIDENT_REF_PER_KCHAR
  )
    warn(
      "incident-log-shape",
      `${refs} PR/issue references; state the rule, drop the history.`,
    );

  if (skillDir) {
    for (const f of FORBIDDEN_FILES)
      if (existsSync(join(skillDir, f)))
        warn("forbidden-file", `skill ships '${f}'.`);
    const refDir = join(skillDir, "references");
    if (existsSync(refDir) && readdirSync(refDir).length > MAX_REFERENCE_FILES)
      warn("references-sprawl", "too many reference files.");
    for (const m of body.matchAll(
      /\b((?:references|scripts|assets)\/[\w./-]+)/g,
    )) {
      if (!existsSync(join(skillDir, m[1]!)))
        warn(
          "dangling-reference",
          `body references '${m[1]}' which does not exist.`,
        );
    }
  }
  return out;
}
