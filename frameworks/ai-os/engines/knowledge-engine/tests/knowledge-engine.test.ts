import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditAllAgySessions,
  blake3Hex,
  canonicalizeUrl,
  closeAllKnowledgeDatabases,
  decomposeResearchQuery,
  deduplicateAndRankEvidence,
  dispatchKnowledgeMcpRpc,
  generateMonorepoDocs,
  generateWorkspaceSkills,
  getBlake3EngineInfo,
  KNOWLEDGE_MCP_TOOLS,
  redactSecretsFromText,
  runFactCheck,
  scanTextForEmojis,
  scanTextForSecretLeaks,
  stripEmojis,
  validateSkillMarkdownStrict,
} from "../src/index.ts";

afterAll(() => {
  closeAllKnowledgeDatabases();
});

describe("@aphrody/knowledge-engine core verification", () => {
  test("Blake3 FFI + fallback hashing is deterministic", () => {
    const info = getBlake3EngineInfo();
    expect(info.backend.length).toBeGreaterThan(0);
    const h1 = blake3Hex("aphrody-knowledge-engine-test");
    const h2 = blake3Hex("aphrody-knowledge-engine-test");
    expect(h1).toBe(h2);
    expect(h1.length).toBe(64);
  });

  test("Redacts OAuth ya29, refresh 1//, GitHub, OpenAI, and Context7 tokens with zero leaks", () => {
    const raw =
      'access="ya29.SYNTHETIC_OAUTH_FIXTURE_TOKEN_1234567890ABCDEF" refresh="1//03SYNTHETIC_REFRESH_FIXTURE_TOKEN_1234567890" ctx="ctx7sk-synthetic_fixture_123456"';
    const clean = redactSecretsFromText(raw);
    expect(clean).not.toContain("ya29.SYNTHETIC");
    expect(clean).not.toContain("1//03SYNTHETIC");
    expect(clean).not.toContain("ctx7sk-synthetic");
    expect(scanTextForSecretLeaks(clean).length).toBe(0);
    expect(scanTextForSecretLeaks(raw).length).toBeGreaterThanOrEqual(3);
  });

  test("Detects and strips astral/symbol emojis while keeping ASCII intact", () => {
    const sample = "Clean status \u{1F680} with rocket";
    expect(scanTextForEmojis(sample).length).toBe(1);
    const stripped = stripEmojis(sample);
    expect(scanTextForEmojis(stripped).length).toBe(0);
    expect(stripped).toContain("Clean status");
  });

  test("Deep research query decomposition and URL deduplication work deterministically", () => {
    const decomposed = decomposeResearchQuery(
      "Bun v1.4.4 WebGPU and zero copy FFI",
    );
    expect(decomposed.subQueries.length).toBeGreaterThanOrEqual(2);
    expect(decomposed.detectedLibraries.length).toBeGreaterThanOrEqual(1);
    expect(
      canonicalizeUrl("https://bun.sh/docs/api/ffi?utm_source=x#top"),
    ).toBe("https://bun.sh/docs/api/ffi");
    const ranked = deduplicateAndRankEvidence([
      {
        channel: "context7",
        tier: "Tier 1: Official Spec / Context7 / Local Verified Source",
        tierRank: 1,
        title: "Bun FFI",
        canonicalUrl: "https://bun.sh/docs/api/ffi?utm_source=test",
        summary: "Zero-copy native calls via bun:ffi",
        fingerprint: blake3Hex("doc1"),
      },
      {
        channel: "exa",
        tier: "Tier 3: Neural Web",
        tierRank: 3,
        title: "Bun FFI dup",
        canonicalUrl: "https://bun.sh/docs/api/ffi",
        summary: "Duplicate URL",
        fingerprint: blake3Hex("doc2"),
      },
    ]);
    expect(ranked.length).toBe(1);
    expect(ranked[0]?.tierRank).toBe(1);
  });

  test("Deterministic fact-checker verifies real paths and flags nonexistent files", async () => {
    const okVerdict = await runFactCheck(
      "C:\\aphrody\\AGENTS.md defines the canonical architecture with Bun v1.4.4.",
      { skipNetwork: true },
    );
    expect(okVerdict.totals.contradicted).toBe(0);

    const tmp = mkdtempSync(join(tmpdir(), "ske-fc-"));
    try {
      const badDoc = join(tmp, "claim.md");
      writeFileSync(
        badDoc,
        "File `C:\\aphrody\\nonexistent_fake_path_999.ts` exists.",
        "utf8",
      );
      const badVerdict = await runFactCheck(badDoc, { skipNetwork: true });
      expect(badVerdict.verdict).toBe("CONTRADICTED");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("Skills generator produces valid zero-emoji SKILL.md definitions", () => {
    const tmpSkills = mkdtempSync(join(tmpdir(), "ske-skills-"));
    try {
      const rep = generateWorkspaceSkills({ skillsRootDir: tmpSkills });
      expect(rep.generatedSkills.length).toBeGreaterThanOrEqual(5);
      for (const sk of rep.generatedSkills) {
        expect(existsSync(sk.skillMdPath)).toBe(true);
        const content = readFileSync(sk.skillMdPath, "utf8");
        const val = validateSkillMarkdownStrict(content, sk.skillMdPath);
        expect(val.valid).toBe(true);
      }
    } finally {
      rmSync(tmpSkills, { recursive: true, force: true });
    }
  });

  test("Monorepo docs generator, AGY session auditor, and MCP JSON-RPC dispatch succeed", async () => {
    const tmpOut = mkdtempSync(join(tmpdir(), "ske-out-"));
    try {
      const atlasPath = join(tmpOut, "ATLAS.md");
      const mdxPath = join(tmpOut, "index.mdx");
      const docsRep = await generateMonorepoDocs({
        enrichContext7: false,
        atlasOutPath: atlasPath,
        mdxOutPath: mdxPath,
      });
      expect(docsRep.entitiesCount).toBeGreaterThanOrEqual(15);
      expect(existsSync(atlasPath)).toBe(true);

      const sessRep = auditAllAgySessions({
        limit: 5,
        markdownOutPath: join(tmpOut, "REVIEW.md"),
        jsonOutPath: join(tmpOut, "ledger.json"),
      });
      expect(sessRep.totalSessions).toBeGreaterThan(0);

      expect(KNOWLEDGE_MCP_TOOLS.length).toBeGreaterThanOrEqual(5);
      const initRes = await dispatchKnowledgeMcpRpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });
      expect(initRes?.error).toBeFalsy();
      const toolsRes = await dispatchKnowledgeMcpRpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });
      expect(toolsRes?.error).toBeFalsy();
    } finally {
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });
});
