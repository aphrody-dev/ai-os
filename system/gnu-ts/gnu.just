# GNU upstream tracker (imported by the root justfile). Doc: docs/native/gnu/DISTRIBUTION.md.

# ay gnu <status|search|package|feed|diff|kernel|sync|site>: GNU upstream, Rust equivalents, Linux kernel
[group('gnu')]
gnu *args:
    bun "{{root}}/system/gnu-ts/src/cli.ts" {{args}}

# Tracker service on fr2 (aphrody-gnu.service): status, last cycles and feed age
[group('gnu')]
gnu-service:
    ssh fr2 "systemctl is-active aphrody-gnu.service aphrody-gnu-watch.timer; journalctl -u aphrody-gnu --no-pager -n 15"

# Tests of the tracker package
[group('gnu')]
gnu-test:
    bun test system/gnu-ts
