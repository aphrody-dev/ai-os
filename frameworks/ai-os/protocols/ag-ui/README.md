# @aphrody/ag-ui

<!-- catalog:begin unit -->

> Aphrody AG-UI Protocol — Pure Bun & TypeScript 7 suite connecting Agentic UI events, streaming lifecycle, Protobuf codec, A2UI surfaces, and Agent-to-User bridges.

| Type        | Path                               |
| :---------- | :--------------------------------- |
| Bun package | `frameworks/ai-os/protocols/ag-ui` |

**Commands**

```sh
bun run --cwd frameworks/ai-os/protocols/ag-ui typecheck
bun run --cwd frameworks/ai-os/protocols/ag-ui test
```

Part of Aphrody: [aphrody-labs/ay](../../../../README.md), [Catalog](../../../../docs/reference/catalog/package.md).
<!-- catalog:end -->

One import for the AG-UI protocol in Aphrody surfaces: the `@ag-ui/core` event schema, the
`@ag-ui/encoder` SSE/Protobuf `EventEncoder`, the Protobuf codec (`encodeProto`, `decodeProto`,
`AGUI_MEDIA_TYPE`), the agent client runtime (`@ag-ui/client`, served by the Aphrody build
`@aphrody/ag-ui-client`) and the A2UI declarative toolkit (`@ag-ui/a2ui-toolkit`).

```ts
import { EventEncoder, EventType, decodeProto } from "@aphrody/ag-ui";

const encoder = new EventEncoder();
const frame = encoder.encodeSSE({
  type: EventType.RUN_STARTED,
  threadId: "t",
  runId: "r",
});
```

- Source: `src/index.ts` (re-exports only; no protocol code is copied).
- Versions: the root catalog pins `@ag-ui/*` 1.0.1; the client is `npm:@aphrody/ag-ui-client`.
- `_resetWarnedCountKeys` (token-usage warning reset used by tests) comes from the
  `@ag-ui/core@1.0.1` patch in `patches/ag-ui-core-1.0.1.patch`.
- Tests: `bun test` replays the cross-language wire fixtures (`fixtures/null-omission.json`) through
  SSE and Protobuf. Typecheck: `bun run typecheck`.
