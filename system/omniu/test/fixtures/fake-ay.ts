// Stand-in for the ay binary: the same `plugin manifest|names` and `sh -c` contract, no Rust build needed.
const [cmd, sub, ...rest] = Bun.argv.slice(2);
const commands = [{ name: "sh", about: "engine" }, { name: "plugin", about: "plugin surface" }, { name: "up", about: "tools" }];
if (cmd === "plugin" && sub === "manifest") {
  console.log(JSON.stringify({ api: process.env.FAKE_AY_API ?? "aphrody:plugin@0.1.0", name: "ay", version: "9.9.9", engine: { name: "rubash", build: "fake" }, commands, hosts: { niu: { api: "niubash:plugin@0.1.0", manifest: "m" }, bun: { module: "ay", entry: "e" } } }));
} else if (cmd === "plugin" && sub === "names") {
  for (const c of commands) console.log(c.name);
} else if (cmd === "env") {
  console.log(JSON.stringify({ a: process.env.FAKE_A ?? null, b: process.env.FAKE_B ?? null }));
} else if (cmd === "sh" && sub === "-c") {
  console.log(`ran:${rest.join("|")}:host=${process.env.AY_PLUGIN_HOST}`);
  process.exit(Number(rest[0]?.startsWith("exit ") ? rest[0].slice(5) : 0));
} else {
  console.error(`fake-ay: unknown ${cmd} ${sub}`);
  process.exit(2);
}
