// SessionStart : lance en détaché `claude -p "/learn"` au plus une fois par 24 h. Non bloquant, sort toujours 0.
try {
  if (!process.env.LEARN_AUTO_CHILD) {
    const H = process.env.USERPROFILE ?? process.env.HOME;
    const lock = `${H}/.claude/learning/learn-auto.lock`;
    const f = Bun.file(lock);
    const last = (await f.exists()) ? Number(await f.text()) || 0 : 0;
    if (Date.now() - last > 86_400_000) {
      await Bun.write(lock, String(Date.now()));
      const p = Bun.spawn(
        ["claude", "-p", "/learn", "--dangerously-skip-permissions"],
        {
          cwd: `${H}/.claude`,
          env: { ...process.env, LEARN_AUTO_CHILD: "1" },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          detached: true,
          windowsHide: true,
        },
      );
      p.unref();
    }
  }
} catch {}
process.exit(0);
