import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintContent, SkillLintError, Skills } from "../../src/core/index";

test("lint: Hermes rule ids", () => {
  const ids = lintContent(
    "---\nname: Bad Name\ndescription: a powerful tool\n---\nuse `cat` here",
  ).map((f) => f.rule);
  expect(ids).toEqual(
    expect.arrayContaining([
      "name-format",
      "description-marketing",
      "shell-utility-reference",
      "missing-section",
    ]),
  );
  expect(lintContent("no front matter")[0]?.rule).toBe("frontmatter-missing");
});

test("skills: create adds When to Use, usage, curate stale/archive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-skills-"));
  const skills = new Skills(dir);
  const s = await skills.create(
    "Deploy Site",
    "Deploy the site to prd",
    "1. build\n2. push",
  );
  expect(s.body).toContain("## When to Use");
  expect(s.warnings.filter((w) => w.rule === "missing-section")).toEqual([]);
  await skills.view("deploy-site");
  expect((await skills.usage())["deploy-site"]?.uses).toBe(1);
  const day = 86_400_000;
  expect(await skills.curate(30, 90, Date.now() + 31 * day)).toEqual({
    "deploy-site": "stale",
  });
  expect(await skills.curate(30, 90, Date.now() + 91 * day)).toEqual({
    "deploy-site": "archived",
  });
  expect((await skills.list()).length).toBe(0);
  expect((await skills.list(true)).length).toBe(1);
  await expect(skills.create("x", "", "body")).rejects.toBeInstanceOf(
    SkillLintError,
  );
});
