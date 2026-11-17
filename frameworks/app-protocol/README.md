# ai-os-app-protocol

Wire types of the OpenAI Codex app-server v2 JSON-RPC dialect as spoken by `aphrody app-server`,
plus the `aphrody/*` protocol extensions. Pure data types with serde derives: no I/O, no async
runtime, `wasm32-unknown-unknown` compatible.


## Protocol invariants

- Outbound frames never carry `"jsonrpc": "2.0"`; inbound frames may.
- Request ids are strings or integers (`RequestId`).
- Tier-1 coverage: `initialize`, `thread/*`, `turn/*`, `model/*`, `config/*`, `account/*`,
  `mcpServerStatus/*`, `tools/list`, `notifications/drain`, `shutdown` and the streaming
  notifications.
- `aphrody/*` methods are available when the client declares `capabilities.aphrody`.

## Main types

| Type | Direction |
| --- | --- |
| `ClientRequest` | client to server requests, tagged by `method` |
| `ServerRequest` | server to client requests (command, file-change and permission approvals, tool user input) |
| `ServerNotification` | server to client notifications (thread, turn and item events) |
| `JSONRPCRequest`, `JSONRPCNotification`, `JSONRPCResponse`, `JSONRPCError`, `JSONRPCMessage` | untyped envelopes |

## Example

```rust
use ai_os_app_protocol::{JSONRPCError, JSONRPCRequest, RequestId};
use serde_json::json;

let request = JSONRPCRequest::new("id-1", "thread/start", Some(json!({ "cwd": "/work" })));
assert!(!serde_json::to_string(&request)?.contains("jsonrpc"));

let inbound: JSONRPCRequest =
    serde_json::from_str(r#"{"jsonrpc":"2.0","id":7,"method":"shutdown"}"#)?;
assert_eq!(inbound.id, RequestId::from(7i64));

let error = JSONRPCError::method_not_found("id-2", "unknown/method");
assert_eq!(error.error.code, -32601);
# Ok::<(), serde_json::Error>(())
```

## License

Apache-2.0.

## Restoration

Legacy name: this unit was published on crates.io as `aphrody-app-protocol`. It is restored here as `ai-os-app-protocol` (`publish = false`; nothing is published from this repository by hand).

| Type | Path |
| :-- | :-- |
| Rust crate | `frameworks/app-protocol` |

```sh
cargo test -p ai-os-app-protocol
cargo clippy -p ai-os-app-protocol --all-targets -- -D warnings
```

Rust builds run on the build host or in CI, not on a workstation.

Part of Aphrody: [aphrody-dev/ai-os](../../README.md).
