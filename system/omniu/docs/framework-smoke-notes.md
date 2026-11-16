# Framework Smoke Notes

Status: living runtime QA notes for the directory-first framework.

## Current Smoke Command

Run with the selected installed Niubash binary:

```sh
niubash tools/smoke_framework.niu C:/path/to/oh-my-niu
```

The smoke currently verifies:

- default framework load: `prompt-core git`;
- prompt API functions: `niubash_prompt_render_left` and
  `niubash_prompt_git_info`;
- all official theme plugins: `minimal`, `classic`, `pure`, `compact`,
  `cyberpunk`, `forest`, and `ocean`;
- Git prompt snapshot contract: `prompt-core` sets `NIU_PROMPT_GIT`, and
  `niubash_prompt_git_info` reads that snapshot;
- devtool plugin aliases/functions from `git`, `docker`, `kubectl`, and `npm`;
- lifecycle hook execution through the `dotenv` plugin.

Host-side (Niubash) test coverage of this bundle on current master is
limited to the prompt segment contract: `prompt_segments.rs` pins the
segment ids and presets mirrored in `prompts/segments.toml` and
resolves this repository's file in a test. The wider host-side
regression list that used to be tracked here (bundle inventory
loading, directory plugins replacing packs, host prompt sync consuming
`NIU_PROMPT_*` and `NIU_PROMPT_GIT`, enablement gating host aliases and
completions) covered the retired built-in plugin stack (niubash#145)
and no longer exists on the host; the framework-side equivalents are
covered by the smoke above.

## Runtime Findings

- Prompt rendering must be lazy. The prompt renderer should only evaluate
  segments present in the active template. Eagerly evaluating every registered
  segment caused unused `{time}` to spawn `date` and leak visible output on the
  installed Niubash build.
- Git prompt helpers should avoid fragile redirection inside command
  substitution on the installed Niubash build. The current helper captures Git
  branch/status without putting `2>/dev/null` inside the captured branch
  command.
- Smoke scripts should prefer stable native paths such as `C:/tmp` for temp
  files. The installed build exposes a `/c/Users/.../Temp` value for `TMPDIR`
  that can fail during redirected writes.

## Next Smoke Gates

- Expand prompt snapshot smoke coverage for dirty/chpwd/git-command
  invalidation through the framework's own precmd/preexec dispatch.
- Add richer prompt API renderer tests once host prompt rendering can call
  plugin segment/provider functions directly instead of only consuming exported
  template variables.
- Add bridge-plugin tests when keybinding and command-not-found host APIs can
  consume directory plugin identity directly.
