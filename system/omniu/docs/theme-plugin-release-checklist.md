# 0.10.0 Theme And Plugin Release Checklist

This checklist tracks the remaining work before publishing Niubash 0.10.0 and
oh-my-niu 1.0.1. The direction is plugin-first: Niubash core provides
prompt/theme/plugin APIs, while visible prompt and theme behavior lives in
bundled source plugins.

## Upstream References

- [x] Powerlevel10k checked out at `../_upstream_refs/powerlevel10k`
  - `config/p10k-classic.zsh`
  - `config/p10k-lean.zsh`
  - `config/p10k-rainbow.zsh`
  - `config/p10k-pure.zsh`
  - `config/p10k-robbyrussell.zsh`
- [x] romkatv/gitstatus checked out at `../_upstream_refs/gitstatus`
- [x] Oh My Zsh checked out at `../_upstream_refs/ohmyzsh`
  - `themes/robbyrussell.zsh-theme`
  - `themes/agnoster.zsh-theme`
  - `themes/bira.zsh-theme`
  - `themes/avit.zsh-theme`
  - `themes/lambda.zsh-theme`
  - `themes/fishy.zsh-theme`
  - `themes/clean.zsh-theme`
- [x] fish-shell checked out at `../_upstream_refs/fish-shell`
  - `share/functions/fish_prompt.fish`
  - `share/functions/prompt_pwd.fish`
  - `share/functions/fish_git_prompt.fish`
  - `share/prompts/*.fish`
- [x] Oh My Posh checked out at `../_upstream_refs/oh-my-posh`
  - `themes/agnoster.omp.json`
  - `themes/dracula.omp.json`
  - `themes/catppuccin_mocha.omp.json`
  - `themes/gruvbox.omp.json`
  - `themes/spaceship.omp.json`
  - `themes/tokyonight_storm.omp.json`

## Core Tasks

- [x] Keep `~/.niubashrc` as the primary interactive entry.
- [x] Keep `~/.winshrc.toml` out of the picture entirely: current Niubash never reads it (plugin CLI state lives in `~/.niubash/plugins.json`).
- [x] Move official prompt/theme behavior into `oh-my-niu/plugins/*`.
- [x] Keep Niubash core limited to prompt/theme/plugin APIs and native services.
- [x] Add `niubash setup` as a repeatable theme/plugin wizard.
- [x] Backup existing `~/.niubashrc` before wizard rewrites it.
- [x] Preview each theme choice during setup with an actual sample prompt line.
- [x] Render prompt cwd as `~` / `~/path` by default, with configurable full path.
- [x] Keep Git prompt refresh from repainting the input line with unthemed text.
- [x] Preserve Git snapshot flow: prompt render uses the framework-maintained `NIU_PROMPT_GIT` snapshot only (no host daemon exists).
- [x] Keep dirty Git compact markers on the dirty theme style instead of falling
  back to white/gray detail text.
- [x] Resolve setup/prompt/config HOME through env-aware Windows path handling
  so `/c/Users/...`, `C:/Users/...`, and `~` agree.

## Theme Plugins

- [x] `theme-p10-classic` from Powerlevel10k classic.
- [x] `theme-p10-lean` from Powerlevel10k lean.
- [x] `theme-p10-rainbow` from Powerlevel10k rainbow.
- [x] `theme-p10-pure` from Powerlevel10k pure.
- [x] `theme-robbyrussell` from Oh My Zsh and Powerlevel10k robbyrussell.
- [x] `theme-agnoster` from Oh My Zsh and Oh My Posh agnoster.
- [x] `theme-bira` from Oh My Zsh bira.
- [x] `theme-avit` from Oh My Zsh avit.
- [x] `theme-lambda` from Oh My Zsh lambda.
- [x] `theme-fishy` from Oh My Zsh fishy and fish-shell default prompt behavior.
- [x] `theme-clean` from Oh My Zsh clean.
- [x] `theme-dracula` from Oh My Posh dracula.
- [x] `theme-catppuccin-mocha` from Oh My Posh catppuccin mocha.
- [x] `theme-gruvbox` from Oh My Posh gruvbox.
- [x] `theme-spaceship` from Oh My Posh spaceship.
- [x] `theme-tokyonight` from Oh My Posh tokyonight storm.
- [x] Mark Nerd Font themes clearly in docs and setup previews.

## Plugin Shape

- [x] `prompt-core` owns prompt template API and Git status snapshot handoff.
- [x] `git` owns aliases/helpers, not prompt rendering.
- [x] `common-aliases`, `path-tools`, and `extract` are source plugins.
- [x] Remove misleading "built-in themes" language from user-facing help.
- [x] Let users turn prompt/theme plugins off by explicit rc configuration.
- [x] Keep compatibility `packs/*` as metadata/assets only until release tools no
  longer need them.

## Validation And Release

- [x] `cargo fmt --check -p niubash`
- [x] `cargo test -p niubash-runtime --lib --locked`
- [x] `cargo test --test repl_command --locked`
- [x] `cargo test --test plugin_inventory --locked`
- [x] rubash focused path regressions:
  - `cargo test pwd --locked`
  - `cargo test cd_updates_pwd --locked`
  - `cargo test process_substitution_command_list --locked`
- [x] `uv run python tools/validate_bundle.py`
- [x] `uv run python tools/package_bundle.py --check`
- [x] `cargo build --release --locked -p niubash`
- [x] Backup installed binary, bundle, user rc, and installed Codex skill.
- [x] Install rebuilt binary and updated oh-my-niu bundle locally.
- [x] Smoke test installed `cat.exe ~/.niubashrc`, `cd ~`, `niubash setup`, and
  Git prompt daemon behavior.
  - AppData binary: `Niubash 0.10.0`, WinuxCmd `0.14.3`.
  - `~/tools/niubash.exe`: `Niubash 0.10.0`, WinuxCmd `0.13.0`.
  - `cd ~; echo PWD=$PWD; pwd; cat.exe ~/.niubashrc` prints native
    `C:/Users/...` and succeeds.
  - `niubash setup` generates an isolated temporary `.niubashrc` with theme
    previews and `NIU_PROMPT_CWD_STYLE='home'`.
  - `--gitstatus-daemon` JSONL smoke passed through the `~/tools` entry; the
    AppData binary passed direct command-mode smoke, while this Codex
    PowerShell wrapper denied AppData stdin redirection.
- [ ] Commit before tagging.
- [ ] Tag/release `0.10.0` only after the checked items are complete.
