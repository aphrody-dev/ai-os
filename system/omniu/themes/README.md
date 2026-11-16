# Theme Assets

Official Niubash theme assets use the same TOML style schema as user themes under `~/.niubash/themes`.

These files are static style data. Runtime theme behavior belongs to
`plugins/theme-*`, where each theme selects prompt-core templates and symbols.

Themes inspired by Powerlevel10k, Agnoster, Dracula, Catppuccin, Gruvbox,
Spaceship, and Tokyo Night may use Nerd Font glyphs in their plugin templates.
The TOML files still use plain style data so users can override foreground and
background colors with exact hex values.
