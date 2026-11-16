// "aphrody" App manifest: each event has its permission, no key refused by GitHub's validator.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import {
  appJwt,
  EVENT_PERMISSION,
  EVENTS,
  manifest,
  PERMISSIONS,
} from "./github-app";

describe("manifeste", () => {
  test("each event is covered by a granted permission", () => {
    for (const e of EVENTS) {
      const p = EVENT_PERMISSION[e];
      expect(p, e).toBeDefined();
      expect(PERMISSIONS[p!], `${e} -> ${p}`).toBeDefined();
    }
  });
  test("keys refused by the validator are absent (2026-11-13)", () => {
    for (const k of [
      "email_addresses",
      "git_ssh_keys",
      "models",
      "codespaces",
      "organization_copilot_seat_management",
    ])
      expect(PERMISSIONS[k], k).toBeUndefined();
    for (const e of [
      "package",
      "repository_import",
      "repository_vulnerability_alert",
    ])
      expect(EVENTS).not.toContain(e);
  });
  test("valid levels, metadata read-only, public App with active webhook", () => {
    for (const [k, v] of Object.entries(PERMISSIONS))
      expect(["read", "write", "admin"], k).toContain(v);
    expect(PERMISSIONS.metadata).toBe("read");
    expect(PERMISSIONS.workflows).toBe("write");
    const m = manifest();
    expect(m.public).toBe(true);
    expect(m.hook_attributes.active).toBe(true);
    expect(new Set(m.default_events).size).toBe(m.default_events.length);
  });
});

describe("JWT", () => {
  test("RS256, iss = client id, exp <= 10 min", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const jwt = appJwt(privateKey, "Iv23test");
    const [h, b, sig] = jwt.split(".");
    const body = JSON.parse(Buffer.from(b!, "base64url").toString());
    expect(JSON.parse(Buffer.from(h!, "base64url").toString()).alg).toBe(
      "RS256",
    );
    expect(body.iss).toBe("Iv23test");
    expect(body.exp - body.iat).toBeLessThanOrEqual(600);
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${h}.${b}`),
        publicKey,
        Buffer.from(sig!, "base64url"),
      ),
    ).toBe(true);
  });
});
