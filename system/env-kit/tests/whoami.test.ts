import { expect, test } from "bun:test";
import { formatIdentities, whoami } from "../src/whoami";

test("providers without credentials report unset, never a secret", async () => {
  const ids = await whoami({});
  for (const p of [
    "cloudflare",
    "ovh",
    "hostinger",
    "vercel",
    "neon",
    "npm",
    "crates.io",
  ])
    expect(ids.find((i) => i.provider === p)?.status).toBe("unset");
  expect(
    formatIdentities([{ provider: "x", status: "ok", identity: "me" }]),
  ).toContain("x");
}, 60_000);
