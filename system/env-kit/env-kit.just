# Env vault and auth daemon (imported by the root justfile).

# Check masked .env vault and multi-editor auth wiring
[group('env')]
env-doctor:
    bun run --cwd "{{root}}/system/env-kit" src/cli.ts doctor

# Auth service of this host (env-kit auth-daemon.ts): real probe every 5 min, unattended refresh, one grouped notice per credential per 24 h
[group('env')]
[windows]
auth-daemon-install:
    schtasks /Create /F /SC ONLOGON /TN aphrody-auth-daemon /TR "conhost.exe --headless \"$(bun -e 'process.stdout.write(process.execPath)')\" run --cwd \"{{root}}/system/env-kit\" src/cli.ts auth daemon --every 5 --refresh 30"
    schtasks /Run /TN aphrody-auth-daemon

[group('env')]
[unix]
auth-daemon-install:
    install -Dm644 "{{root}}/device/fleet/systemd/aphrody-auth-daemon.service" "$HOME/.config/systemd/user/aphrody-auth-daemon.service"
    systemctl --user daemon-reload && systemctl --user enable --now aphrody-auth-daemon
