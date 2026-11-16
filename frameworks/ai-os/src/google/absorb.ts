#!/usr/bin/env bun
// Tracking of the absorbed copies of google-labs-code / android and skill mirrors. Single source: the forks
// third_party/<checkout> described by tools/upstream/stacks.d/google-labs.toml (`absorbed` section).
//   check            for each absorbed copy: upstream files modified since the recorded commit
//                    (missing fork = ignored, except with --strict)
//   skills [--write] generated mirrors of the stitch-skills, jules-skills and android-skills skills in
//                    .agents/skills/<prefix>-<name> (read by all agents; Claude Code through the .claude/skills link).
//                    Without --write: diff only, exit code 1 if the mirror drifts.
// Skill commands are rewritten for bun (npx/npm/node -> bunx/bun) and a banner points to the
// surfaces de src (outils relais stitch__*, ay design, ay jules, android-ndk-compose / Theme.kt / sys.h).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

const root = resolve(
  Bun.env.SRC_ROOT ?? join(import.meta.dir, "..", "..", "..", ".."),
);
const STACKS = join(root, "tools", "upstream", "stacks.d", "google-labs.toml");

type Absorbed = { commit: string; paths: string[]; into: string };
type Stack = {
  checkout: string;
  upstream: string;
  ref: string;
  absorbed?: Absorbed;
};

export function stacks(): Record<string, Stack> {
  return (
    Bun.TOML.parse(readFileSync(STACKS, "utf8")) as {
      stack: Record<string, Stack>;
    }
  ).stack;
}

const git = (cwd: string, args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim() };
};

export function check(strict: boolean): number {
  let drift = 0;
  for (const [name, s] of Object.entries(stacks())) {
    if (!s.absorbed) continue;
    const dir = join(root, s.checkout);
    if (!existsSync(join(dir, ".git"))) {
      console.log(
        `${name}: ${s.checkout} missing${strict ? "" : " (ignored)"}`,
      );
      if (strict) drift++;
      continue;
    }
    git(dir, [
      "fetch",
      "--quiet",
      `https://github.com/${s.upstream}.git`,
      `+refs/heads/${s.ref}:refs/remotes/upstream/${s.ref}`,
    ]);
    const tip =
      git(dir, ["rev-parse", `refs/remotes/upstream/${s.ref}`]).out ||
      git(dir, ["rev-parse", "HEAD"]).out;
    const changed = git(dir, [
      "diff",
      "--name-only",
      s.absorbed.commit,
      tip,
      "--",
      ...s.absorbed.paths,
    ]).out;
    const files = changed ? changed.split("\n") : [];
    console.log(
      files.length
        ? `${name}: ${files.length} upstream file(s) modified since ${s.absorbed.commit.slice(0, 12)} -> ${tip.slice(0, 12)} (copy: ${s.absorbed.into})\n  ${files.join("\n  ")}`
        : `${name}: up to date (${s.absorbed.commit.slice(0, 12)}, ${s.absorbed.into})`,
    );
    drift += files.length ? 1 : 0;
  }
  return drift ? 1 : 0;
}

type SkillSource = {
  prefix: string;
  from: string;
  skill: string;
  repo: string;
};

/** Individual skill directories across stitch-skills, jules-skills, and android-skills. */
function skillSources(): SkillSource[] {
  const s = stacks();
  const out: SkillSource[] = [];
  const stitch = join(root, s["stitch-skills"]!.checkout, "plugins");
  if (existsSync(stitch))
    for (const plugin of readdirSync(stitch).sort()) {
      const skillsDir = join(stitch, plugin, "skills");
      if (!existsSync(skillsDir)) continue;
      for (const skill of readdirSync(skillsDir)
        .filter((n) => existsSync(join(skillsDir, n, "SKILL.md")))
        .sort()) {
        out.push({
          prefix: "stitch",
          from: join(skillsDir, skill),
          skill,
          repo: "google-labs-code/stitch-skills",
        });
      }
    }
  const jules = join(root, s["jules-skills"]!.checkout, "skills");
  if (existsSync(jules))
    for (const skill of readdirSync(jules)
      .filter((n) => existsSync(join(jules, n, "SKILL.md")))
      .sort()) {
      out.push({
        prefix: "jules",
        from: join(jules, skill),
        skill,
        repo: "google-labs-code/jules-skills",
      });
    }
  const androidCheckout = s["android-skills"]?.checkout;
  if (androidCheckout) {
    const androidRoot = join(root, androidCheckout);
    const pluginPath = join(androidRoot, ".claude-plugin", "plugin.json");
    if (existsSync(pluginPath)) {
      const manifest = JSON.parse(readFileSync(pluginPath, "utf8")) as {
        skills?: string[];
      };
      for (const relSkill of [...(manifest.skills ?? [])].sort()) {
        const from = resolve(androidRoot, relSkill);
        if (existsSync(join(from, "SKILL.md"))) {
          out.push({
            prefix: "android",
            from,
            skill: basename(from),
            repo: "android/skills",
          });
        }
      }
    }
  }
  return out;
}

const BANNER = (repo: string, rel: string) =>
  repo === "android/skills"
    ? `> Mirror generated from ${repo} (${rel}) by \`bun frameworks/ai-os/src/google/absorb.ts skills --write\`; do not edit here.
> In src: entry skill \`.agents/skills/android-ndk-compose/SKILL.md\`, Material 3 Expressive tokens \`frameworks/design/tokens/adapters/Theme.kt\`,
> Pure C11/JNI/NDK ABI \`kernel/include/ay/sys.h\` (\`kernel/include/uapi/ay/ui.h\`, \`libaysys.so\`). JS/TS: bun only.
`
    : `> Mirror generated from ${repo} (${rel}) by \`bun frameworks/ai-os/src/google/absorb.ts skills --write\`; do not edit here.
> In src: relay Stitch tools \`stitch__<tool>\` (MCP \`mcp__relay__stitch__*\`, gcloud auth), CLI \`ay design stitch <cmd>\`
> (upload, design-md, generate, html, download), DESIGN.md \`ay design lint|export\` (system: frameworks/design/DESIGN.md),
> Jules \`ay jules run|sessions\` and tools \`jules_run\`, \`jules_status\`. JS/TS: bun only.
`;

/** bun in place of the tools it replaces, in the text of the skills and their scripts. */
export function bunify(text: string): string {
  return text
    .replace(/\bnpx tsx\b/g, "bun")
    .replace(/\bnpx\b/g, "bunx")
    .replace(/\bnpm install -g\b/g, "bun add -g")
    .replace(/\bnpm install -D\b/g, "bun add -d")
    .replace(/\bnpm (install|i)\b/g, "bun install")
    .replace(/\bnpm (run|create|test)\b/g, "bun $1")
    .replace(/\bnode -e\b/g, "bun -e");
}

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

export function mirror(
  write: boolean,
): { skill: string; file: string; kind: string }[] {
  const dst = join(root, ".agents", "skills");
  const drift: { skill: string; file: string; kind: string }[] = [];
  const stage = mkdtempSync(join(tmpdir(), "absorb-skills-"));
  try {
    const skillNames: string[] = [];
    for (const src of skillSources()) {
      const name = `${src.prefix}-${src.skill.replace(new RegExp(`^${src.prefix}-`), "")}`;
      skillNames.push(name);
      const stageSkill = join(stage, name);
      const rel = relative(join(root, "third_party"), src.from).replaceAll(
        "\\",
        "/",
      );
      for (const f of files(src.from)) {
        const r = relative(src.from, f).replaceAll("\\", "/");
        let text = readFileSync(f, "utf8").replaceAll("\r\n", "\n");
        if (/\.(md|sh|ts|tsx|js|json|yml)$/.test(f)) text = bunify(text);
        if (r === "SKILL.md") {
          // Frontmatter name aligned on the directory (agents index skills by folder); banner after it.
          text = text.replace(
            /^(---\n[\s\S]*?\n)---\n/,
            (_m, fm: string) =>
              `${fm.replace(/^name:.*$/m, `name: ${name}`)}---\n\n${BANNER(src.repo, rel)}\n`,
          );
        }
        const stagedPath = join(stageSkill, r);
        mkdirSync(dirname(stagedPath), { recursive: true });
        writeFileSync(stagedPath, text);
      }
    }
    Bun.spawnSync([process.execPath, "fmt", "--no-script", stage], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

    for (const name of skillNames) {
      const stageSkill = join(stage, name);
      const to = join(dst, name);
      const want = new Map<string, string>();
      for (const f of files(stageSkill)) {
        const r = relative(stageSkill, f).replaceAll("\\", "/");
        want.set(r, readFileSync(f, "utf8").replaceAll("\r\n", "\n"));
      }
      const have = existsSync(to)
        ? files(to).map((f) => relative(to, f).replaceAll("\\", "/"))
        : [];
      for (const [r, text] of want) {
        const target = join(to, r);
        const cur = existsSync(target)
          ? readFileSync(target, "utf8").replaceAll("\r\n", "\n")
          : null;
        if (cur === text) continue;
        drift.push({
          skill: name,
          file: r,
          kind: cur === null ? "missing" : "changed",
        });
        if (write) {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, text);
        }
      }
      for (const r of have)
        if (!want.has(r)) {
          drift.push({ skill: name, file: r, kind: "extra" });
          if (write) rmSync(join(to, r));
        }
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return drift;
}

if (import.meta.main) {
  const [cmd, ...rest] = Bun.argv.slice(2);
  if (cmd === "check") process.exit(check(rest.includes("--strict")));
  if (cmd === "skills") {
    if (!skillSources().length) {
      console.log(
        "skills: stitch-skills / jules-skills / android-skills forks missing (third_party), nothing to compare",
      );
      process.exit(0);
    }
    const write = rest.includes("--write");
    const d = mirror(write);
    for (const x of d) console.log(`${x.kind}\t${x.skill}/${x.file}`);
    console.log(`${d.length} diff(s)${write ? " fixed" : ""}`);
    process.exit(!write && d.length ? 1 : 0);
  }
  console.error("usage: absorb.ts check [--strict] | skills [--write]");
  process.exit(2);
}
