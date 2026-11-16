// Regenerate completions/jj.toml from the official `jj util completion bash` output (port of tools/convert_jj_completions.py).
//
// The parser targets clap_complete's bash output (one `opts="..."` per `case "${cmd}"` branch). It extracts the top-level
// flags, every level-1 subcommand with its own flags, and the static value lists of `--flag)` / `compgen -W "..."` cases.

export function convertJjCompletions(src: string): string {
  const level1 = [...src.matchAll(/jj,([A-Za-z0-9_-]+)\)\s*\n?\s*cmd="jj__subcmd__\1"/g)].map((m) => m[1]!);
  const branches = new Map<string, string[]>();
  for (const m of src.matchAll(/\n\s+(jj__subcmd__[A-Za-z0-9_]+|jj)\)\n\s+opts="([^"]*)"/g)) branches.set(m[1]!, m[2]!.split(/\s+/).filter(Boolean));
  const values = new Map<string, string[]>();
  for (const m of src.matchAll(/(--[A-Za-z0-9_-]+)\)\n\s+COMPREPLY=\(\$\(compgen -W "([^"]*)"/g)) {
    if (!values.has(m[1]!)) values.set(m[1]!, m[2]!.split(/\s+/).filter(Boolean));
  }
  const out = [
    "# jj completions for niubash / oh-my-niu.",
    "# Generated from the official `jj util completion bash` output.",
    "# Regenerate: jj util completion bash | omniu convert-jj > completions/jj.toml",
    'command = "jj"',
    'description = "Jujutsu VCS (Git-compatible)"',
    "",
  ];
  const flagBlock = (flag: string, sub: boolean) => {
    const lines = [sub ? "[[subcommands.flags]]" : "[[flags]]", `${flag.startsWith("--") ? "long" : "short"} = ${JSON.stringify(flag)}`];
    const v = values.get(flag);
    if (v?.length) lines.push(`values = [${v.map((x) => JSON.stringify(x)).join(", ")}]`);
    lines.push("");
    return lines;
  };
  const flagsOf = (tokens: string[]) => [...new Set(tokens.filter((t) => t.startsWith("-")))].sort();
  for (const flag of flagsOf(branches.get("jj") ?? [])) out.push(...flagBlock(flag, false));
  for (const name of level1) {
    const tokens = branches.get(`jj__subcmd__${name}`);
    if (!tokens) continue;
    out.push("[[subcommands]]", `name = ${JSON.stringify(name)}`, "");
    for (const flag of flagsOf(tokens)) out.push(...flagBlock(flag, true));
  }
  return out.join("\n");
}
