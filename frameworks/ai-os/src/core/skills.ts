// Agent Skills (SKILL.md) store. Semantics ported from Hermes Agent (MIT, Nous Research):
// skill_manager_tool (create after a successful task), skill_linter (lint on write), skill_usage (use counts,
// active -> stale -> archived curation). Usage lives in <dir>/.usage.json.
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "./context";
import { type LintFinding, lintContent, parseSkill } from "./skill-lint";

export type Skill = {
  name: string;
  description: string;
  body: string;
  path: string;
};
export type SkillState = "active" | "stale" | "archived";
export type Usage = {
  uses: number;
  createdAt: string;
  lastUsedAt?: string;
  state: SkillState;
  pinned?: boolean;
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);

export class SkillLintError extends Error {
  constructor(readonly findings: LintFinding[]) {
    super(findings.map((f) => `${f.rule}: ${f.message}`).join("; "));
  }
}

export class Skills {
  constructor(
    readonly dir: string,
    readonly ctx?: Context,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  /** Index active skills into Context (source "skill"), drop archived ones. Skill reads go through Context.select. */
  async sync() {
    if (!this.ctx) return;
    const active = await this.list();
    await this.ctx.ingest(
      active.map((s) => ({
        id: `skill:${s.name}`,
        source: "skill",
        scope: "skills",
        title: s.name,
        text: s.description,
      })),
    );
    const names = new Set(active.map((s) => `skill:${s.name}`));
    for (const e of this.ctx.list({ sources: ["skill"] }))
      if (!names.has(e.id)) this.ctx.remove(e.id);
  }

  private get usageFile() {
    return join(this.dir, ".usage.json");
  }
  async usage(): Promise<Record<string, Usage>> {
    const f = Bun.file(this.usageFile);
    return (await f.exists()) ? f.json() : {};
  }
  private async saveUsage(u: Record<string, Usage>) {
    await Bun.write(this.usageFile, JSON.stringify(u, null, 2));
  }

  async create(
    name: string,
    description: string,
    body: string,
  ): Promise<Skill & { warnings: LintFinding[] }> {
    const id = slug(name);
    if (!id) throw new Error("invalid skill name");
    const desc = description.replace(/\s+/g, " ").trim();
    let text = body.trim();
    if (!/^#+\s+When to [Uu]se/m.test(text))
      text = `## When to Use\n\n${desc}\n\n## Procedure\n\n${text}`;
    const content = `---\nname: ${id}\ndescription: ${desc}\n---\n\n${text}\n`;
    const findings = lintContent(content);
    const errors = findings.filter((f) => f.severity === "error");
    if (errors.length) throw new SkillLintError(errors);
    mkdirSync(join(this.dir, id), { recursive: true });
    const path = join(this.dir, id, "SKILL.md");
    await Bun.write(path, content);
    const u = await this.usage();
    u[id] = {
      createdAt: new Date().toISOString(),
      state: "active",
      uses: u[id]?.uses ?? 0,
    };
    await this.saveUsage(u);
    await this.ctx?.ingest({
      id: `skill:${id}`,
      source: "skill",
      scope: "skills",
      title: id,
      text: desc,
    });
    return {
      name: id,
      description: desc,
      body: text,
      path,
      warnings: findings,
    };
  }

  async list(includeArchived = false): Promise<Skill[]> {
    const out: Skill[] = [];
    const roots = includeArchived
      ? [this.dir, join(this.dir, ".archive")]
      : [this.dir];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const id of readdirSync(root)) {
        const path = join(root, id, "SKILL.md");
        if (!existsSync(path)) continue;
        const p = parseSkill(await Bun.file(path).text());
        out.push({
          name: id,
          description: p?.front.description ?? "",
          body: p?.body ?? "",
          path,
        });
      }
    }
    return out;
  }

  /** Load a skill body and record a use (reactivates a stale skill). */
  async view(name: string): Promise<Skill | undefined> {
    const s = (await this.list()).find((x) => x.name === name);
    if (!s) return undefined;
    const u = await this.usage();
    const rec = u[name] ?? {
      uses: 0,
      createdAt: new Date().toISOString(),
      state: "active",
    };
    rec.uses += 1;
    rec.lastUsedAt = new Date().toISOString();
    rec.state = "active";
    u[name] = rec;
    await this.saveUsage(u);
    return s;
  }

  /** Mark unused skills stale after `staleDays`, archive after `archiveDays` (pinned skills exempt). */
  async curate(staleDays = 30, archiveDays = 90, now = Date.now()) {
    const u = await this.usage();
    const changed: Record<string, SkillState> = {};
    for (const [name, rec] of Object.entries(u)) {
      if (rec.pinned || rec.state === "archived") continue;
      const idle =
        (now - Date.parse(rec.lastUsedAt ?? rec.createdAt)) / 86_400_000;
      if (idle >= archiveDays) {
        const from = join(this.dir, name);
        if (existsSync(from)) {
          mkdirSync(join(this.dir, ".archive"), { recursive: true });
          renameSync(from, join(this.dir, ".archive", name));
        }
        rec.state = changed[name] = "archived";
        this.ctx?.remove(`skill:${name}`);
      } else if (idle >= staleDays && rec.state !== "stale")
        rec.state = changed[name] = "stale";
    }
    await this.saveUsage(u);
    return changed;
  }
}
