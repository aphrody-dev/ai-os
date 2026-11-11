import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";

const stagePath = "C:/Users/aphro/.local/bin/ai-os.stage.exe";
const targetPath = "C:/Users/aphro/.local/bin/ai-os.exe";
const oldPath = "C:/Users/aphro/.local/bin/ai-os.prev.exe";

const build = Bun.spawnSync(
  [
    "bun",
    "build",
    "--compile",
    "--minify",
    "src/cli.ts",
    "--outfile",
    stagePath,
  ],
  { stdout: "inherit", stderr: "inherit" },
);

if (build.exitCode !== 0) {
  process.exit(build.exitCode);
}

try {
  if (existsSync(oldPath)) {
    try {
      rmSync(oldPath, { force: true });
    } catch {
      // ignore if previous process still exiting
    }
  }
  if (existsSync(targetPath)) {
    renameSync(targetPath, oldPath);
  }
  renameSync(stagePath, targetPath);
} catch {
  copyFileSync(stagePath, targetPath);
  rmSync(stagePath, { force: true });
}

console.log(`Installed ${targetPath}`);
