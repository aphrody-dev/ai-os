// CLI entry point for `ai-os term`
import { parseArgs } from "node:util";
import { launchTermDesktopWindow, startTermServer } from "./server.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string" },
    host: { type: "string" },
    profile: { type: "string" },
    theme: { type: "string" },
    app: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  strict: false,
});

if (values.help) {
  console.log(
    "ai-os term [--port 8795] [--profile niubash|pwsh|opencode] [--theme aphrody-m3-dark] [--app]",
  );
  process.exit(0);
}

const srv = await startTermServer({
  port: values.port ? Number(values.port) : undefined,
  host: typeof values.host === "string" ? values.host : undefined,
  defaultProfile:
    typeof values.profile === "string" ? values.profile : undefined,
  theme: typeof values.theme === "string" ? values.theme : undefined,
});

console.log(`aphrody-term listening on ${srv.baseUrl}`);
console.log(`open: ${srv.launchUrl}`);

if (values.app) {
  launchTermDesktopWindow(srv.launchUrl);
}

process.on("SIGINT", () => {
  srv.stop();
  process.exit(0);
});

await new Promise(() => {});
