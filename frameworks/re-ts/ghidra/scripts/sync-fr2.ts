// Push frameworks/re-ts/ghidra, system/ghidra-bun and frameworks/re (path dependency) to a remote work dir without git:
//   bun scripts/sync-fr2.ts [host=cdn] [dest=/home/ubuntu/ghidra-work]
import { fileURLToPath } from "node:url";

const host = process.argv[2] ?? "cdn";
const dest = process.argv[3] ?? "/home/ubuntu/ghidra-work";
const root = fileURLToPath(new URL("../../../..", import.meta.url));
const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

const mk = Bun.spawnSync(["ssh", host, `timeout 60 mkdir -p ${q(dest)}`]);
if (mk.exitCode !== 0) throw new Error(`mkdir failed: ${mk.stderr.toString()}`);
const tar = Bun.spawnSync(["tar", "-cf", "-", "--exclude=node_modules", "--exclude=target", "-C", root, "frameworks/re-ts/ghidra", "system/ghidra-bun", "frameworks/re"]);
if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
const un = Bun.spawnSync(["ssh", host, `timeout 300 tar -xf - -C ${q(dest)}`], { stdin: tar.stdout });
console.log("sync exit", un.exitCode, un.stderr.toString());
process.exitCode = un.exitCode ?? 1;
