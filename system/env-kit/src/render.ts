// SPDX-License-Identifier: Apache-2.0
// usage: bun render.ts <template> [out]    replaces @@a.b.c@@ tokens with discovered values (discover.ts).
import { writeFileSync } from "node:fs";
import { readExpanded } from "./discover.ts";

const [src, out] = Bun.argv.slice(2);
if (!src) {
  console.error("usage: bun render.ts <template> [out]");
  process.exit(2);
}
const text = await readExpanded(src);
if (out) writeFileSync(out, text);
else process.stdout.write(text);
