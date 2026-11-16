import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, extname, join, relative } from "path";
import type { WebFilesContext } from "./types";

export function loadWebContext(targetPath: string): WebFilesContext {
  const resolved = targetPath;
  if (!existsSync(resolved)) {
    throw new Error(`Target path does not exist: ${resolved}`);
  }

  const stat = statSync(resolved);
  const isSingleFile = stat.isFile();

  const ctx: WebFilesContext = {
    targetPath: resolved,
    isSingleFile,
    htmlFiles: [],
    cssFiles: [],
    jsFiles: [],
    wasmFiles: [],
    wgslFiles: [],
  };

  if (isSingleFile) {
    const ext = extname(resolved).toLowerCase();
    const content = readFileSync(resolved, "utf-8");
    const relPath = basename(resolved);

    if (ext === ".html" || ext === ".htm") {
      ctx.htmlFiles.push({ path: resolved, relPath, content });
    } else if (ext === ".css") {
      ctx.cssFiles.push({
        path: resolved,
        relPath,
        content,
        size: stat.size,
      });
    } else if (ext === ".js" || ext === ".ts") {
      ctx.jsFiles.push({
        path: resolved,
        relPath,
        content,
        size: stat.size,
      });
    } else if (ext === ".wasm") {
      ctx.wasmFiles.push({
        path: resolved,
        relPath,
        bytes: new Uint8Array(readFileSync(resolved)),
      });
    } else if (ext === ".wgsl") {
      ctx.wgslFiles.push({ path: resolved, relPath, content });
    }

    // Check sibling files for robots, sitemap, llms if single HTML file
    const parentDir = join(resolved, "..");
    const robotsPath = join(parentDir, "robots.txt");
    if (existsSync(robotsPath)) {
      ctx.robotsTxt = readFileSync(robotsPath, "utf-8");
    }
    const sitemapPath = join(parentDir, "sitemap.xml");
    if (existsSync(sitemapPath)) {
      ctx.sitemapXml = readFileSync(sitemapPath, "utf-8");
    }
    const llmsPath = join(parentDir, "llms.txt");
    if (existsSync(llmsPath)) {
      ctx.llmsTxt = readFileSync(llmsPath, "utf-8");
    }

    return ctx;
  }

  // Directory traversal
  function walkDir(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      // vendor/: pinned third-party runtimes (SHA-256 in the app lock); the gate audits first-party output only.
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "vendor"
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        const relPath = relative(resolved, fullPath).replace(/\\/g, "/");

        if (ext === ".html" || ext === ".htm") {
          ctx.htmlFiles.push({
            path: fullPath,
            relPath,
            content: readFileSync(fullPath, "utf-8"),
          });
        } else if (ext === ".css") {
          const content = readFileSync(fullPath, "utf-8");
          const s = statSync(fullPath);
          ctx.cssFiles.push({
            path: fullPath,
            relPath,
            content,
            size: s.size,
          });
        } else if (ext === ".js" || ext === ".ts") {
          const content = readFileSync(fullPath, "utf-8");
          const s = statSync(fullPath);
          ctx.jsFiles.push({
            path: fullPath,
            relPath,
            content,
            size: s.size,
          });
        } else if (ext === ".wasm") {
          ctx.wasmFiles.push({
            path: fullPath,
            relPath,
            bytes: new Uint8Array(readFileSync(fullPath)),
          });
        } else if (ext === ".wgsl") {
          ctx.wgslFiles.push({
            path: fullPath,
            relPath,
            content: readFileSync(fullPath, "utf-8"),
          });
        } else if (entry.name.toLowerCase() === "robots.txt") {
          ctx.robotsTxt = readFileSync(fullPath, "utf-8");
        } else if (entry.name.toLowerCase() === "sitemap.xml") {
          ctx.sitemapXml = readFileSync(fullPath, "utf-8");
        } else if (entry.name.toLowerCase() === "llms.txt") {
          ctx.llmsTxt = readFileSync(fullPath, "utf-8");
        }
      }
    }
  }

  walkDir(resolved);
  ctx.htmlFiles.sort((a, b) => {
    if (a.relPath === "index.html") return -1;
    if (b.relPath === "index.html") return 1;
    return a.relPath.localeCompare(b.relPath);
  });
  return ctx;
}
