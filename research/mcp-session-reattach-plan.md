---
last_updated: "2026-06-25"
status: proposed
---

# MCP session reattach for Streamable HTTP connections

## Summary

Some Streamable HTTP MCP servers keep working state in the MCP session. A common pattern is a setup
tool that selects or configures a working context, followed by later tools that read that context
from the MCP session.

eve currently rebuilds connection clients at workflow/model step boundaries. That is correct for
durable execution because live MCP clients, HTTP streams, timers, and sockets are not serializable.
However, rebuilding the `@ai-sdk/mcp` client starts a fresh MCP session, so stateful servers can
lose session-local setup between steps when an app intentionally relies on MCP-session state.

This should be opt-in per MCP connection. The implementation shape should keep the live connection
registry virtual for every connection, but persist small reconnect metadata in eve's durable context
only when the connection asks for durable MCP session continuity:

```ts
export const McpSessionStateKey = new ContextKey<Record<string, DurableMcpSessionState>>(
  "eve.mcpSessionState",
);

interface DurableMcpSessionState {
  readonly sessionId: string;
  readonly initializeResult: InitializeResult;
  readonly generation: number;
}
```

When present, this state is serialized by eve's existing `serializeContext(ctx)` path as
`serializedContext["eve.mcpSessionState"]`. It is not part of the model transcript, channel request
body, or user-visible messages.

## Verified upstream behavior

Representative Streamable HTTP MCP server implementations:

- create a new `Mcp-Session-Id` for `initialize`;
- require subsequent non-initialize requests to carry that session id;
- return 404 when a request references a terminated session;
- treat DELETE as session termination rather than local client detachment.

This means eve cannot preserve session-scoped setup by sending an old session id on a fresh
`initialize`. eve needs to reattach to the existing MCP session without running a new initialize,
and it must not DELETE the remote session when it only wants to detach locally between workflow
steps.

## Dependency

AI SDK draft PR: `vercel/ai#16399`.

The planned eve implementation assumes `@ai-sdk/mcp` exposes:

- `transport.initialSessionId`
- `transport.initialProtocolVersion`
- `transport.onSessionIdChange`
- `transport.onSessionExpired`
- `transport.terminateSessionOnClose`
- `createMCPClient({ initialInitializeResult })`
- `MCPClient.initializeResult`

If that PR changes shape, adapt this plan to the final AI SDK API before implementation.

## Developer-facing behavior

The first version should be disabled by default. Existing Streamable HTTP MCP connections should
keep today's behavior: each rebuilt client starts a fresh upstream MCP session, and closing the
client may terminate that upstream session according to the MCP client's normal close behavior.

Default-off avoids silently extending upstream session lifetimes, retaining server-side resources,
or preserving state on servers that treat client close as a cleanup boundary. It also keeps existing
apps on the same behavior they already rely on.

App authors opt in only for MCP servers whose tool semantics require session-scoped setup to survive
eve workflow/model step boundaries. They still should not pass, persist, or inspect raw MCP session
ids; the option only asks eve to manage spec-native reattach metadata internally.

```ts title="agent/connections/workspace.ts"
import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://service.example/mcp",
  description:
    "Workspace service. Use its setup tools before follow-up tools that depend on selected state.",
  auth: connect({ connector: "workspace/my-agent", principalType: "user" }),
  session: {
    continuity: "durable",
  },
});
```

`session.continuity: "durable"` is the proposed public shape; the exact field name can change during
implementation review. The important contract is opt-in behavior. When enabled, the expected
behavior during one eve session is:

1. The model discovers remote tools through `connection_search`.
2. A remote setup tool stores working context in the upstream MCP session.
3. The turn parks or crosses a workflow/model step boundary.
4. eve rebuilds the live MCP client, reattaches with framework-owned context metadata, and later
   remote tools observe the same upstream MCP session.

Example tool trace:

```text
connection_search("workspace")
workspace__set_selected_state({ id: "..." })
...durable step boundary...
workspace__get_selected_state({})
```

`workspace__get_selected_state` should see the state selected earlier because eve reused the same
upstream MCP session. This is session continuity, not a new durable app-state API: the selected
state still belongs to the MCP server, and eve only stores the protocol metadata required to
reattach.

For connections that do not opt in, legacy SSE MCP servers, or servers that do not support
`MCP-Session-Id` reattach, app behavior is unchanged. For expired upstream sessions, the first
implementation should clear the stale protocol metadata and surface the failure or retry only safe
metadata operations; the MCP server should expose enough setup tools and descriptions for the model
to establish state again. A future replay layer can add an authored hook or connection option for
re-establishing setup after expiry, but valid-session reattach should not require app code beyond the
connection-level opt-in.

## DX options considered

There are a few plausible public API shapes. The strongest option is a small declarative opt-in,
with more explicit helpers added later only where they solve a concrete authoring problem.

| Option | Example shape | Strengths | Risks |
| --- | --- | --- | --- |
| Connection-level opt-in | `session: { continuity: "durable" }` | Smallest app-facing API; keeps MCP session ids out of user code; lets eve enforce per-session and per-principal scoping; works with existing model/tool flow. | Less flexible when upstream sessions expire; naming must be clear that this is MCP-session continuity, not durable business state. |
| Lower-level session helpers | `ctx.connections.workspace.clearSession()` / `terminateSession()` | Useful for explicit reset, logout, tests, and operational cleanup; action-oriented helpers avoid exposing raw protocol tokens. | Still leaks MCP session lifecycle into authored code; helpers need careful availability rules so models cannot accidentally clear shared context through ordinary remote tools. |
| Raw session metadata access | `getSessionId()` / `setSessionId(...)` | Maximum escape hatch; mirrors the underlying protocol closely. | Easy to misuse; authors may store or share session ids incorrectly; creates cross-user leakage and resource-lifetime hazards; couples eve's public API to AI SDK transport details. |
| Authored replay hook | `session: { continuity: "durable", replay: async (...) => ... }` | Handles expired upstream sessions and server restarts by re-establishing setup state; keeps raw session ids hidden. | Requires a durable, JSON-serializable app state model; replayed setup must be idempotent and safe; too much surface for the first version. |
| Server/app state instead of MCP session state | Include the selected id in each tool call, or have the MCP server persist state by user/token. | Most robust when the server can support it; avoids client-side session lifetime concerns. | Not always available for third-party MCP servers; can make model prompts and tool schemas more repetitive. |
| Session-level global switch | `client.session({ mcpSessionContinuity: true })` | Easy for a whole app or UI to turn on. | Too broad: different MCP servers have different lifetime semantics, so the choice belongs on the connection. |

Recommended layering:

1. Ship connection-level opt-in as the first public API.
2. Keep raw session ids and initialize metadata framework-owned.
3. Add action-oriented helpers only if authors need explicit reset or cleanup.
4. Add a replay hook later if valid-session reattach is not enough for servers with short-lived or
   in-memory sessions.
5. Avoid a public `getSessionId()`/`setSessionId()` API unless there is a strong debugging need and
   it can be clearly marked unstable/internal.

## Prior art

The official MCP TypeScript SDK separates local transport teardown from remote session termination:

- `StreamableHTTPClientTransport` accepts `sessionId` and `protocolVersion` constructor options.
- When `Client.connect()` sees a transport with an existing `sessionId`, it treats that as a
  reconnect path and skips a fresh `initialize`.
- `transport.close()` only closes local transport resources.
- `transport.terminateSession()` sends HTTP DELETE with `Mcp-Session-Id`, treats 405 as allowed by
  the spec, and clears the local session id after termination.
- Server session management is also opt-in: `sessionIdGenerator` enables stateful sessions, while
  omitting it puts the server transport in stateless mode.
- The server transport's `onsessionclosed` callback is specifically tied to DELETE, and its docs call
  out that request-local transports may close while the logical session stays open.

Vercel's `mcp-handler` mostly follows a stateless Streamable HTTP default:

- the default Streamable HTTP path creates a fresh server and transport per POST;
- GET and DELETE on the Streamable HTTP endpoint return 405 in that default path;
- `sessionIdGenerator` is passed through to the official SDK transport for stateful sessions, but it
  is an explicit server-side choice rather than the default;
- Redis-backed resumability is focused on the legacy SSE path and uses session ids as routing keys
  for request/response pub-sub, not as a client-side reattach API.

Lessons for eve:

- Match the official SDK distinction between local close/detach and explicit session termination.
- Keep continuity opt-in because both the MCP spec and common handlers treat stateful sessions as
  optional.
- Store enough metadata to follow the official reconnect path: `sessionId`, negotiated protocol
  version, and cached initialize result.
- Prefer action-oriented helpers like `clearSession()` or `terminateSession()` over raw
  `getSessionId()`/`setSessionId()` access if an escape hatch becomes necessary.
- Consider naming the public option after "reattach" or "per-eve-session" continuity, since the
  official SDK uses "session" for a transport protocol concept and "durable" can sound broader than
  the feature actually is.

## Where state is saved

Use durable context, not the workflow body as an authored input shape and not external storage.

Current eve flow:

1. `createWorkflowRuntime().run()` builds a context and calls `serializeContext(ctx)`.
2. `turnStep()` deserializes `input.serializedContext`.
3. runtime code mutates durable context values with `ctx.set(...)`.
4. `turnStep()` returns `serializeContext(ctx)` for the next durable step or turn.

For opted-in connections, `McpSessionStateKey` should follow that same pattern. The workflow payload
carries it because the payload carries all serialized context, but the data is framework-owned
context metadata.

Why this location:

- It is already scoped to the eve session.
- It survives workflow step boundaries and parks.
- It avoids an external database migration for reconnect metadata.
- It remains invisible to the LLM and channel adapters unless framework code reads it.
- It keeps live `MCPClient` instances out of durable state.

## State keying

Inside `McpSessionStateKey`, key by connection and principal:

```ts
const cacheKey = `${connection.connectionName}:${principalKey(principal)}`;
```

The serialized context is already per eve session, so the eve session id does not need to be in the
inner map key. If this state is moved to an external KV or database later, include the eve session
id in the external key:

```text
eveSessionId + connectionName + principalKey
```

Keep app-scoped MCP sessions per eve session. Even if the bearer token is shared, session-scoped MCP
state is conversational working context and must not leak across sessions.

## Runtime integration

`ConnectionRegistryKey` remains virtual and step-local.

`ConnectionRegistryImpl` continues constructing `McpConnectionClient`. For the default path, client
creation should keep today's behavior and not touch `McpSessionStateKey`. For opted-in Streamable
HTTP connections, the client reads and writes `McpSessionStateKey` from the active context when
creating an HTTP MCP client.

Sketch:

```ts
const ctx = loadContext();
const principal = resolveConnectionPrincipal(connection.connectionName, authorization, ctx);
const cacheKey = `${connection.connectionName}:${principalKey(principal)}`;
const shouldReattach = connection.session?.continuity === "durable";
const state = shouldReattach ? (ctx.get(McpSessionStateKey) ?? {}) : {};
const saved = shouldReattach ? state[cacheKey] : undefined;

let currentSessionId = saved?.sessionId;

const client = await createMCPClient({
  transport: {
    type: "http",
    url,
    headers,
    ...(shouldReattach
      ? {
          initialSessionId: saved?.sessionId,
          initialProtocolVersion: saved?.initializeResult.protocolVersion,
          terminateSessionOnClose: false,
          onSessionIdChange(sessionId) {
            currentSessionId = sessionId;
          },
          onSessionExpired(sessionId) {
            ctx.set(McpSessionStateKey, (prev = {}) => {
              if (prev[cacheKey]?.sessionId !== sessionId) return prev;
              const { [cacheKey]: _expired, ...rest } = prev;
              return rest;
            });
            currentSessionId = undefined;
          },
        }
      : {}),
  },
  ...(shouldReattach ? { initialInitializeResult: saved?.initializeResult } : {}),
});

if (shouldReattach && currentSessionId) {
  ctx.set(McpSessionStateKey, (prev = {}) => ({
    ...prev,
    [cacheKey]: {
      sessionId: currentSessionId,
      initializeResult: client.initializeResult,
      generation: (saved?.generation ?? 0) + 1,
    },
  }));
}
```

`generation` is a stale-write guard. If a future implementation has overlapping connection clients
for the same key, only allow a callback or save to replace state when it is based on the current
generation.

## HTTP and SSE fallback

Keep the current Streamable HTTP first, SSE fallback behavior.

Only opted-in Streamable HTTP connections use `McpSessionStateKey`. Legacy SSE does not have an
equivalent `MCP-Session-Id` reattach mechanism, so it should ignore and not update this state.

If HTTP creation fails with a fallback-eligible compatibility error before a session is established,
fall back to SSE as today. If HTTP fails because a stored session expired, clear the stored state and
retry HTTP fresh once before considering SSE fallback.

## Close behavior

For default MCP connections, keep today's close behavior. If the MCP client terminates the upstream
session on close, that is fine because the connection did not opt into session continuity.

For opted-in connections, when the runtime disposes the virtual `ConnectionRegistryImpl` at a step
boundary, `client.close()` must only detach the local client. It must not terminate the remote MCP
session that eve intends to reuse next step.

Use:

```ts
terminateSessionOnClose: false
```

Later, if eve gets an explicit terminal-session cleanup hook where no future reattach is possible,
it can optionally terminate stored MCP sessions with DELETE. That is an optimization, not required
for correctness.

## Expiry behavior

When a request carrying a stored session id receives 404:

1. `onSessionExpired` clears `McpSessionStateKey[cacheKey]`.
2. The current request still fails with the transport error.
3. For safe metadata operations, reconnect fresh and retry once.
4. For arbitrary tool execution, do not blindly retry if the runtime cannot prove the server did
   not process the call.

Safe to retry automatically:

- `listTools`
- other read-only setup/metadata calls if the runtime owns them

Not safe to retry automatically:

- model-requested tool calls with possible side effects

For session-scoped setup, expiry means the setup may need to happen again. The normal non-expired
case should preserve setup without server-specific replay code.

## Optional replay layer

The first implementation should focus on preserving valid MCP sessions.

A later generic replay layer can help when an MCP server expires state or after a deployment loses
in-memory upstream sessions. That layer should be connection-authored and JSON-serializable, for
example "when a setup tool succeeds, remember the selected state and replay it after a fresh MCP
session initializes."

Do not bake server-specific replay into the generic MCP client.

## Files likely to change

- `packages/eve/src/public/definitions/connections/mcp.ts`
  - add the opt-in MCP session continuity option.
- `packages/eve/src/compiler/manifest.ts` and `packages/eve/src/runtime/types.ts`
  - carry the option through compiled and resolved connection definitions.
- `packages/eve/src/context/keys.ts`
  - add `McpSessionStateKey` and durable state types.
- `packages/eve/src/runtime/connections/mcp-client.ts`
  - read/write durable MCP session state only for opted-in connections;
  - pass AI SDK reattach options only for opted-in connections;
  - clear state on session expiry;
  - use `terminateSessionOnClose: false` only for opted-in connections.
- `packages/eve/src/runtime/connections/mcp-client.test.ts`
  - unit coverage for create, persist, reattach, expiry, and fallback.
- Possibly `packages/eve/src/runtime/connections/types.ts`
  - only if a small internal state helper type is better colocated there.

## Test plan

Add unit tests for:

- leaves default MCP connections on fresh-session close behavior and does not write
  `McpSessionStateKey`;
- captures `MCPClient.initializeResult` and `sessionId` after first opted-in HTTP client creation;
- serializes opted-in MCP session state through `serializeContext(ctx)`;
- rehydrates from `serializedContext` and passes `initialSessionId`, `initialProtocolVersion`, and
  `initialInitializeResult` on the next opted-in client creation;
- sets `terminateSessionOnClose: false` only for opted-in HTTP transports;
- scopes state by connection name and resolved principal key;
- does not share app-scoped MCP session state across eve sessions;
- clears only the matching stored session id on `onSessionExpired`;
- does not apply Streamable HTTP session state to SSE fallback;
- retries fresh once for safe metadata operations after expiry;
- does not blindly retry arbitrary mutating tool calls after expiry.

Optional integration test:

- fake Streamable HTTP MCP server stores `selectedState` by `MCP-Session-Id`;
- first step calls `set_selected_state`;
- next durable continuation step calls `get_selected_state`;
- test passes only if eve reattaches to the same MCP session.

## Rollout notes

- Gate implementation on an AI SDK version that includes `vercel/ai#16399` or equivalent API.
- If the upstream API is delayed, implement an internal transport adapter with the same semantics,
  then delete it once AI SDK support lands.
- Document that this fixes normal step-to-step continuity for stateful Streamable HTTP MCP servers,
  but server-side session expiry can still require user/model recovery unless a replay layer exists.
