# Command-Not-Found Provider ABI Draft
This draft records the bundle-facing expectations for the first provider-style
externalization candidate. The current manifest may use
`exports.providers = ["command-not-found"]` as a guarded marker, but that marker
does not replace the host builtin by itself. No command-not-found provider
binding is implemented in current Niubash (the host's missing-command
surface is its built-in `command-not-found-hint` policy); this draft
records what a future binding would have to look like. WASM providers
remain future work.
## Candidate Pack
- Pack: `command-not-found`
- Current runtime: `builtin`
- Current permission: `command:diagnose`
- Target direction: process provider candidate now; future WASM provider only after Niubash
  defines a separate WASM provider entrypoint and output capture.
## Bundle Requirements
The bundle must not ship a normal command-style replacement for
`command-not-found`. A future process provider would have to use a Niubash command-not-found provider binding that does not exist yet; a command-style WASM
module is not enough because command stdout is user output, while provider
suggestions are host-rendered diagnostics.
A bundle pack that migrates this surface must declare:
- which provider surface it implements;
- required permissions, starting with `command:diagnose`;
- runtime contract and timeout;
- maximum output size;
- fallback behavior when disabled, failing, timing out, or returning no lines.
## Expected Provider Behavior
Input should be deterministic and host-owned:
- missing command string;
- optional cwd when `cwd:read` is granted;
- optional host facts, such as package search helper availability.
Output should be deterministic suggestion lines:
- no env/cwd/history mutation;
- no execution of suggested commands;
- no direct user stdout/stderr writes;
- empty output means Niubash may use compiled fallback hints.
## Fallback Rule
The official bundle must keep the native Niubash fallback until at least one
release proves provider timeout, invalid output, disabled-provider, and
missing-provider paths are safe.
