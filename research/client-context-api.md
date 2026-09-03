---
issue: https://github.com/vercel/eve/pull/2903
status: implemented
last_updated: "2026-09-03"
---

# Client context API

The Client SDK exposes only ephemeral `clientContext`, while authored channels can attach durable `context` to the same delivery. This split prevents browser and HTTP clients from using the framework's existing durable user-context path.

## Existing context lifetimes

| Surface                     | Role and lifetime                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| Channel `context`           | User-role messages appended to durable session history before the delivery.               |
| Dynamic user instructions   | User-role messages appended at the session or turn boundary.                              |
| Dynamic system instructions | Model context outside history, scoped to the session or turn.                             |
| `defineState`               | Durable structured session data that is not automatically model-visible.                  |
| Memory                      | Attributed user-role context recalled from storage outside the session.                   |
| Client `clientContext`      | Client-supplied user-role context for the next model call, excluded from durable history. |

## Observed `clientContext` use cases

Public source and issue history show that ephemeral client context is not only a test fixture:

- [Nuxt](https://github.com/nuxt/nuxt.com/blob/0f866f968a63d0be61ed1ff94ab1855535307188/layers/nuxi/app/composables/useNuxiChat.ts) sends the current page from `prepareSend` before each turn.
- [Autumn](https://github.com/useautumn/autumn/blob/53958367ff530f73896c72554d853e371f01b51b/apps/leaf/src/internal/agentRuntime/eve/client.ts) sends current catalog decisions and approval edits, including HITL responses.
- [Miniscira](https://github.com/zaidmukaddam/miniscira/blob/07a01c39eda4750d2237e6baa4a92c6d983f3fab/lib/chat-context.ts) sends active model, research mode, upload, and project UI state.
- The official [eve chat template](https://github.com/vercel/eve-examples/blob/b9657e9f67b72bd5b7faea50ec917477781bc098/eve-chat-template/app/_components/agent-chat.tsx) sends current connection-toggle state.
- [AI Canvas](https://github.com/kyh/ai-canvas/blob/5959d1c5897c858600b626c820b8653b74983101/src/components/canvas/views/editor-bottom-toolbar.tsx#L319-L328) sends canvas size, background, selection bounds, and selected-block summaries.
- [AI Datagrid](https://github.com/kyh/ai-datagrid/blob/c15724d642456dd14d6947f501a60091f448bed9/src/lib/grid-context.ts#L68-L91) sends columns, filters, sorts, selected cells, and selected-row data.
- [Mission Control](https://github.com/Asymmetric-al/core/blob/7abd2c11ffd4ed70c6775c4fd6f51c996e4350dd/apps/admin/app/eve/page-context.ts#L24-L90) sends allowlisted page, organization, and panel state while excluding record IDs, form values, and Document Object Model content.
- [Issue #2357](https://github.com/vercel/eve/issues/2357) reports a production assistant giving incorrect advice after earlier page and editor snapshots leaked into later turns.

These values are browser-only, mutable, or tied to one interaction. Persisting them changes privacy, staleness, compaction, and prompt-cost behavior. `defineDynamic` can replace them only when the server can derive the same state; it is not a transport for arbitrary browser input.

## Decision

Expose `context?: readonly string[]` on Client create, send, and respond operations. It uses the channel contract: each entry is appended as a user-role message immediately before the delivery, remains available to later turns, and follows compaction and clear. When `onMessage` also returns context, authored channel entries come first and request entries follow in their original order.

Keep `clientContext` unchanged in this proposal. The observed uses cannot move to durable history without a behavior change, and deprecation has no compatible replacement yet. A future naming or lifetime consolidation should account for client-only volatile state and ship with explicit migration guidance.

## Invariants

- `context` never dispatches a turn by itself.
- Context entries are non-empty strings and retain caller order.
- Create, message, and HITL-response deliveries use the same path.
- Channel-authored and client-supplied context become one ordered durable list.
- `clientContext` remains private, ephemeral model input.
- Retries, workflow replay, compaction, and clear keep their existing history semantics.
