---
issue: https://github.com/vercel/eve/issues/4061
status: proposed
last_updated: "2026-09-30"
---

# Public `eve/testing` entry

## Summary

Apps that test authored eve code today import eve's compiled internals.
`vercel/internal-agents` has 51 test files (d0 38, v 6, cse 3, e0 2, sre 1,
hobknob 1) that reach them through `node_modules/eve/dist` paths, paths
joined onto the resolved `eve` or `eve/client` entry, or
`Symbol.for("eve…")`. It also keeps two identical `eve-context.ts` helpers
that re-export `ContextContainer` and `contextStorage`. Every eve release can
break these tests without warning, and the tests still run authored code
differently from how eve runs it.

This doc proposes a small `eve/testing` entry that covers the four needs
behind most of those imports:

- running code inside a session context,
- resolving connections,
- driving channels,
- loading tools the way `eve build` does.

Each helper wraps an eve internal and exposes only eve-owned types. Three
other needs from the issue belong elsewhere and are listed under
[Out of scope](#out-of-scope).

## Current state

Counts come from `git grep` in `vercel/internal-agents` at `9ed0933f7`, the
commit that bumped eve to `e0dd11edf`. Paths are relative to `agents/`.

| Need                                                    | Test files                               | Representative files                                                                          | eve internals used                                                                                                                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Run code in a session context so `defineState` works    | 28 (d0 21, v 4, cse 1, hobknob 1, sre 1) | `d0/agent/lib/turn-metrics.test.ts`, `v/agent/lib/slack-authorization.test.ts`                | `context/container.js`; `context/keys.js` (`AuthKey`, `SessionKey`)                                                                                                                                                |
| Load a tool the way the build does                      | 7 (d0)                                   | `d0/.../dynamic-tool-durable-callbacks.test.ts`, `d0/.../web-fetch-lazy-auth.test.ts`         | `internal/workflow-bundle/dynamic-tool-transform.js`, `context/dynamic-tool-lifecycle.js` (`validateDurableDynamicToolCallbacks`), `tools/durable-callbacks.js`, `Symbol.for("eve:tool-brand")` and 2 more symbols |
| Resolve connections and connection tools                | 3 (d0 2, v 1)                            | `v/.../notion-connection.test.ts`, `d0/.../dynamic-connection-contract.test.ts`               | `runtime/connections/registry.js` (`ConnectionRegistryImpl`), `runtime/resolve-connection.js`, `execution/tools/connection-tools.js`, `context/providers/connection-key.js`                                        |
| Match an authored channel or capture a route's delivery | 4 (d0 3, v 1)                            | `d0/.../slack-escalation-capability.test.ts`, `v/agent/lib/ambient/on-event-dispatch.test.ts` | `Symbol.for("eve.channel.instrumentationKind")`, `channel/compiled-channel.js` (`isCompiledChannel`), `channel/channel-operations.js` (`INTERNAL_CHANNEL_DELIVER`)                                                 |

The d0 helper `agent/lib/__test-helpers__/eve-context.ts` is imported by 20
d0 tests; the sre copy is imported by one. d0 also keeps
`__test-helpers__/transformed-dynamic-tool.ts`, which runs eve's transform and
rewrites the output's import specifiers so the file can be imported.

The underlying gaps in eve:

- **Session context.** `defineState` and the other `eve/context` accessors
  call `loadContext()`, which throws `No active eve context` outside a
  `contextStorage.run(...)` scope. eve's own tests use
  `internal/testing/active-session-context.ts`, which hard-codes
  `auth: { current: null, initiator: null }`, and the app harness's
  `runAsSession`.
- **Tool transform.** The build stamps durable descriptors onto `defineTool()`
  callbacks while it bundles the authored module map
  (`bundleAuthoredModuleMapForGeneration`). Raw source never gets them. When
  a descriptor is missing, `validateDurableDynamicToolCallbacks` throws at
  resolve time. eve then logs
  `Dynamic tool resolver (…) failed — skipping its complete result.` and drops
  every tool the resolver returned. d0's sweep exists because of an incident
  where seven tools vanished this way.
- **Channel identity.** `isChannel(ctx.channel, slack)` compares against the
  `channel:<name>` kind that `runtime/resolve-channel.ts` stamps when it loads
  `agent/channels/<name>.ts`. A test that imports the channel module directly
  gets an unstamped value, so d0 stamps the symbol by hand.
- **Route delivery.** Slack, chat-sdk, and Telegram routes deliver through the
  unexported `INTERNAL_CHANNEL_DELIVER` method on `from(address)`, so a fake
  `from()` must implement it. Ask 1 of #4061 proposes making this the public
  `send()`.

## Proposed API

```ts
import {
  callChannelRoute,
  createTestConnections,
  loadChannel,
  loadTool,
  mockModel,
  runInSessionContext,
} from "eve/testing";
```

### `runInSessionContext`

```ts
interface RunInSessionContextOptions {
  session?: { id?: string; turn?: SessionTurn; parent?: SessionParent };
  auth?: { current?: SessionAuthContext | null; initiator?: SessionAuthContext | null };
  channel?: { kind: string; metadata?: Readonly<Record<string, unknown>> };
  connections?: TestConnections;
}

function runInSessionContext<T>(
  options: RunInSessionContextOptions,
  fn: () => T | Promise<T>,
): Promise<T>;
```

Runs `fn` with a fresh session context bound. `defineState`, the `eve/context`
accessors, and connection lookups behave as they do inside a tool call. The
option types are the public ones from `eve/context`, and `session` uses the
`id` shape authored code sees in `ctx.session`, not the internal `sessionId`.

```ts
import { defineState } from "eve/context";
import { runInSessionContext } from "eve/testing";

const alice = {
  authenticator: "slack",
  principalId: "U0ALICE",
  principalType: "user",
  attributes: { team_id: "T0TEAM" },
};

await runInSessionContext({ auth: { current: alice } }, async () => {
  await recordTurnMetrics(); // authored code that uses defineState
});
```

### `createTestConnections`

```ts
function createTestConnections(connections: Record<string, unknown>): TestConnections;

interface TestConnections {
  listTools(connection: string): Promise<readonly TestToolSummary[]>;
  executeTool(connection: string, tool: string, input: unknown): Promise<unknown>;
  modelTools(): Readonly<Record<string, LoadedTool>> | null;
}
```

Record keys stand in for the path-derived connection names
(`agent/connections/notion.ts` → `"notion"`). Values are what a connection
module or a dynamic connection handler returns. Each value is validated the
way the runtime validates it, so a value not created by
`defineMcpClientConnection()` or `defineOpenAPIConnection()` fails with the
runtime's message. Pass the result to `runInSessionContext({ connections })`.
Calls made inside that scope use its `auth` for token lookup and sign-in.
`modelTools()` returns `connection_search` and `connection_execute`, or `null`
when there are no connections, matching an agent without connections. The
name avoids "registry" because the connection registry is an internal type.

### `loadChannel` and `callChannelRoute`

```ts
function loadChannel(url: URL | string): Promise<{ channel: Channel; kind: string }>;

function callChannelRoute(
  channel: Channel,
  request: Request,
): Promise<{ response: Response; deliveries: readonly TestChannelDelivery[] }>;
```

`loadChannel` imports an authored channel module and applies the same
`channel:<name>` identity the runtime assigns from its file name, so
`isChannel(ctx.channel, channel)` matches when `ctx.channel.kind` is the
returned `kind`. `callChannelRoute` picks the route matching the request's
method and path, as the host does. It supplies route arguments whose
`from(address)` records each delivery, awaits every `waitUntil` task, and
returns the response with the deliveries. A delivery carries the address plus
the public send fields: `message`, `auth`, `state`, `title`, and
`inputResponses`. It works whether the route calls `send()` or the internal
delivery method, so the test is unchanged if ask 1 lands.

The issue asks for a way to build a fake channel of a given kind. The
consumer tests need two different things: the identity of a real authored channel, and a
capture of what a real route delivers. A fake channel of a given kind covers
neither.

### `loadTool`

```ts
function loadTool(url: URL | string): Promise<LoadedToolModule>;

type LoadedToolModule =
  | ({ kind: "static" } & LoadedTool)
  | {
      kind: "dynamic";
      resolve(
        event: "session.started" | "turn.started" | "step.started",
        options?: RunInSessionContextOptions,
      ): Promise<readonly LoadedTool[]>;
    };

interface LoadedTool {
  name: string;
  description: string;
  inputSchema: JsonSchema; // as sent to providers
  execute(input: unknown): Promise<unknown>;
}
```

`loadTool` bundles the module and its authored imports through the same
transforms `eve build` applies, including the workflow directive and dynamic
capability transforms. It then reads the default export. The tool name comes
from the file name (`tools/web_fetch.ts` → `"web_fetch"`), and a dynamic
resolver's map entries use their keys. `resolve()` calls the resolver for one
event with a `DynamicResolveContext` built from the same options as
`runInSessionContext`. It then validates each entry's durable callbacks.
`execute()` runs inside the active `runInSessionContext` scope, or a default
one when none is active.

### `mockModel`

`eve/testing` re-exports `mockModel` from `eve/evals` unchanged. See
[Open questions](#open-questions).

## Semantics

- **Per-call isolation.** Each `runInSessionContext` call gets a new context.
  State written in one call is not visible to another, including concurrent
  and nested calls. A nested call starts empty; it does not inherit from the
  outer call. Outside any call, `eve/context` accessors throw the same
  `No active eve context` error as today.
- **Production defaults.** Omitted options take the values of a first turn in
  a new, unauthenticated session: a unique session id and turn id per call, no
  parent, `auth.current` of `null`, `auth.initiator` equal to `auth.current`,
  no channel kind, no connections, and no sandbox.
- **Transform parity.** `loadTool` output matches what `eve build` produces
  for the same source. A callback the build cannot stamp, such as one carried
  in by a spread, fails in `loadTool` too.
- **Runtime errors.** Helpers throw the runtime's own errors with the same
  messages. The one intended difference is that the runtime logs a failed
  dynamic tool resolver and drops its result, while `resolve()` throws the
  underlying error so the test fails.
- **Public surface only.** Signatures and returned objects use eve-owned types.
  No helper returns `ContextContainer`, a registry instance, a context key, or
  an eve symbol, and no helper exposes third-party types (principle 5 in
  `AGENTS.md`). Internal types have no stability promise, and the helpers do
  not make them reachable.
- **Runner-agnostic.** No dependency on Vitest, no globals, no setup file.
  internal-agents runs both `node:test` and Vitest.

## Out of scope

- **Protocol event builders.** `createMessageReceivedEvent`,
  `stampMessageStreamEvent`, and message types (cse 2 files, d0 5 files)
  describe the client protocol, so they belong in `eve/client`.
- **Skill discovery.** v calls `discoverSkills` to check a subagent skill.
  `eve info --json` already reports root skills in full, but subagent skills
  only as a count and diagnostics only as error and warning counts. Adding
  subagent skill details and diagnostic messages there removes the need.
- **Hooks and the tool loop with a mock model.** cse drives
  `harness/tool-loop.js`, `harness/step-hooks.js`, and
  `context/hook-lifecycle.js`. A public helper would need new seams in
  `harness/`, which the core principles reserve for strict necessity. Defer
  until a smaller public runtime exists.
- **Other asks in #4061.** The remaining imports are covered by other asks:
  `tools/schema.js` (ask 7), `public/channels/slack/hitl.js` (ask 6), and
  `channel/schedule-auth.js` and `runtime/connections/principal.js` (ask 4).
  e0's live test reads the code extension's `instructions.md` from the
  package, which is not a testing API need.

## Removing the need

Two product changes would remove some helper uses outright:

- **An `eve build` diagnostic for unstampable callbacks.** The transform
  already visits every `defineTool()` call. Reporting a callback it cannot
  stamp, such as a spread executor, as a build error would catch the d0
  incident at build time instead of as a silent drop at runtime. d0's sweep
  tests would become unnecessary. `loadTool` would still serve tests of tool
  behavior.
- **Authored channels that carry their kind.** If a channel value knew its
  `channel:<name>` identity without the runtime loader, `isChannel` would
  match in plain imports, and `loadChannel` would only serve route tests. The
  kind is path-derived (principle 7), and a factory like `slackChannel()`
  cannot see its caller's path, so this needs a build-time step that plain
  test imports skip. `loadChannel` stays in the proposal for that reason.

## Testing the helpers

Each helper has one owner test at the `eve/testing` boundary, and none adds a
production seam:

- **Unit:** `runInSessionContext` isolation, nesting, and defaults.
- **Integration:** `createTestConnections` against in-memory connection
  definitions, and `callChannelRoute` against the built-in Slack route.
- **Scenario:** `loadTool` uses the bundler. Extend an existing
  dynamic-tool scenario suite with one inline callback and one spread callback
  rather than booting a new app.
- **Packed package:** add `eve/testing` to the existing
  `public-api-portability` scenario so the export resolves from the tarball
  and its types reference no internal paths.

Where an eve test in `internal/testing` asserts the same contract as a public
helper, it moves to the helper instead of keeping both.

## Rollout

1. This doc.
2. The `./testing` export in `packages/eve/package.json`, plus
   `runInSessionContext`, a `docs/testing.md` page linked from the evals
   overview and added to `docs/meta.json`, and a `patch` changeset.
3. `createTestConnections`.
4. `loadChannel` and `callChannelRoute`, coordinated with ask 1.
5. `loadTool`. The build diagnostic ships separately.
6. Separate PRs: protocol builders in `eve/client`, and subagent skill details
   and diagnostics in `eve info --json`.
7. Migrate internal-agents. Delete both `eve-context.ts` helpers and
   `transformed-dynamic-tool.ts`. The migration is complete when `git grep`
   finds no `eve/dist` paths, `import.meta.resolve("eve")` path joins, or
   `Symbol.for("eve` in tests beyond imports owned by other asks.

## Open questions

- **`ai/test`.** `mockModel` builds on `MockLanguageModelV3` from `ai/test`,
  and `ai` is a peer dependency. Is that acceptable for a testing entry, or
  should `eve/testing` avoid importing `ai/test` until a test calls
  `mockModel`?
- **Re-exporting `mockModel`.** Two import paths for one function make
  `eve/testing` a single import for tests, but also make two documented
  homes. The alternative is to leave it in `eve/evals` and link to it.
- **Scenario cost for `loadTool`.** Could `loadTool` run through the
  in-memory compile path (`internal/testing/compile-from-memory.ts`) so its
  owner test fits the integration tier?
- **Production imports.** Should `eve build` reject `eve/testing` imports from
  authored runtime modules?
- **Channel lifecycle callbacks.** d0's `native-schedule-callbacks.test.ts`
  calls a compiled channel's `session.failed` handler directly. Is a later
  `dispatchChannelEvent` helper warranted, or is that test better served by
  an eval?

## Corrections to #4061

- sre uses only `context/container.js`, through its `eve-context.ts` helper.
  It does not use `context/keys.js`.
- e0's `tools/durable-schema.js` import can switch to `defineDurableSchema`,
  which `eve/tools` already exports.
- The tool-loading row also uses `tools/durable-callbacks.js`,
  `context/build-dynamic-tools.js`, and
  `Symbol.for("eve:durable-dynamic-tool-callbacks")`.
- cse's hook row also uses `context/serialize.js` and
  `runtime/sessions/runtime-context-keys.js`.
