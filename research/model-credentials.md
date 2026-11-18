---
issue: https://github.com/vercel/eve/pull/6551
status: proposed
last_updated: 2026-11-18
---

# Per-user model credentials

> **AI status:** Written entirely by AI; human review pending.

## Summary

A tool can already run on a person's own account. When the person has no credential yet, eve
opens a sign-in, pauses the turn, and runs the tool after the person connects. Some agents need the
same for the model call itself, for example to send each person's AI Gateway requests with that
person's own Vercel access token.

The model call has no way to open a sign-in. A dynamic `model` function can fetch a person's token
itself and build a provider model from it, but when the token doesn't exist yet, the turn fails,
and the person never sees a sign-in. eve resolves credentials for connections, tools, and approval
response policies, and a model ID or provider instance can't declare `auth`.

This doc proposes `defineModel`, which puts a connection-style `auth` on a model:

1. The agent's `model` is a `defineModel` value, directly or from a dynamic `model` function.
2. Before each model call, eve calls `auth.getToken` for the current person.
3. When the person has no credential, eve opens a sign-in, as for a connection, and pauses the turn.
4. After the person connects, the same turn continues. eve passes the `TokenResult` to `create` and
   calls the returned model.

It costs one new definition in `eve/models`. In return, the model call gets the sign-in that tool
calls already have.

## Authoring API

`defineModel` is new, a stable export of `eve/models`:

```ts
import { connect } from "@vercel/connect/eve";
import { createGateway } from "ai";
import { defineAgent } from "eve";
import { defineModel } from "eve/models";

// New: a model with auth.
const ownGateway = defineModel({
  id: "anthropic/claude-sonnet-5",
  auth: connect("vercel/myagent"), // your Vercel Connect connector for Sign in with Vercel
  create: ({ token }) =>
    createGateway({ apiKey: token, teamIdOrSlug: "acme" })("anthropic/claude-sonnet-5"),
});

export default defineAgent({ model: ownGateway });
```

Each person signs in with Vercel, and eve sends their model calls to AI Gateway with their own
Vercel access token. `teamIdOrSlug` scopes the calls to the `acme` team.

Some sessions have no signed-in person, such as a scheduled run or a service that calls the API.
To use a person's own credential only when one is signed in, choose the model per session with
`defineDynamic`:

```ts
import { defineDynamic } from "eve/models";

export default defineAgent({
  model: defineDynamic((ctx) =>
    ctx.session.auth.current?.principalType === "user" ? ownGateway : "anthropic/claude-sonnet-5",
  ),
});
```

A signed-in person gets `ownGateway`. Every other session gets the plain model ID, which runs on
the project's AI Gateway credential, as it does today.

`defineModel` takes a `ModelDefinition` and returns a branded `DefinedModel`, as `defineAgent`
returns a `DefinedAgent`. Both types come from `eve/models`. `id`, `auth`, and `create` are
required:

| Field     | Type                                            | Purpose                                                                                                                                                                                                                 |
| --------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`      | `string`                                        | Identifies the model. eve reports it on `model.started` and as `ctx.model.id`, and looks it up in the AI Gateway model catalog for the context window. eve needs it during model selection, before a credential exists. |
| `auth`    | `AuthorizationDefinition`                       | The credential strategy: `connect(...)` from `@vercel/connect/eve`, `defineInteractiveAuthorization(...)`, or `{ getToken }`, as on a connection.                                                                       |
| `create`  | `(credential: TokenResult) => EveLanguageModel` | Builds the provider model from the credential. It is synchronous; I/O belongs in `auth.getToken`.                                                                                                                       |
| `authKey` | `string`                                        | Sets the sign-in name and the token cache key. Required when `auth` has no Vercel Connect connector. See [Sign-in name](#sign-in-name).                                                                                 |

eve accepts a `DefinedModel` wherever it takes the model for a session's turns. A plain object with
the same fields doesn't compile:

- `defineAgent({ model })` on the root agent and on a declared subagent.
  `defineAgent({ model: ownGateway })` runs every session on the person's own credential, and fails
  a session with no signed-in person.
- The result of `defineDynamic`, directly or as `model` in a
  `{ model, reasoning?, modelContextWindowTokens? }` selection.
- `auto()` `options` and `fallback`, and the `models` options of the built-in `agent` tool.

eve rejects it for calls that can't pause the turn for a sign-in, and where eve saves the model
with the session:

- `compaction.model` and the decision `model` of `auto()` reject it with a definition error.
- `ctx.agent(name, { model })` rejects it as it rejects any provider model.
- A dynamic subagent's returned config rejects it as it rejects any provider model, because eve
  saves that selection with the session. A dynamic subagent that returns `ctx.model.id` runs the AI
  Gateway model with that ID on the project's credential.

More rules:

- `auth` takes one definition. To vary it per caller, return a different `defineModel` value from
  `defineDynamic`.
- Spreading `auth` keeps its Vercel Connect connector, so the sign-in name stays the same.
- An `id` outside the catalog needs `modelContextWindowTokens` in the selection.
- Authors bring their own provider in `create`. `DynamicModelContext`, `anthropic()`, and
  `openai()` stay as they are.

## Behavior

### Before each model call

eve resolves `auth` after dynamic functions run and `limits.sessionUsage` passes, and before
`model.requested`, so a turn that waits on a sign-in has no open model run. eve resolves every
model before `model.requested`, so a model that fails to resolve leaves no requested run on the
stream.

Resolution follows the connection rules. `principalType: "user"` reads the session's current user
and keeps each user's token separate. With `principalType: "app"`, eve never opens a sign-in. A
model has no server URL, so eve passes `connection: { url: "" }` to the `auth` callbacks, as it does
for a tool's inline auth.

### The sign-in

When `getToken` throws `ConnectionAuthorizationRequiredError` and `auth` has
`startAuthorization`, eve opens the same sign-in as a connection: `interaction.opened` with
`request.kind: "sign-in"` and the turn as its subject. Channels show their existing sign-in prompt,
and the turn pauses under the same `turnId`.

- **The person connects.** eve settles the sign-in `accepted` when the callback arrives, as it does
  for any sign-in no tool call owns. The step runs again from the start: the dynamic functions run,
  eve completes the authorization with the selected model's `auth`, and calls the model. If
  `completeAuthorization` throws `ConnectionAuthorizationFailedError`, the turn fails with
  `MODEL_AUTHORIZATION_FAILED`; any other error from it fails the turn with
  `MODEL_CREDENTIAL_FAILED`.
- **The person declines.** eve settles the sign-in `declined` before the dynamic functions run, so
  a dynamic `model` can read the decline from `ctx.view` and return another model.
- **The person sends a message.** The sign-in ends `withdrawn`, and the step runs again. Unless a
  dynamic `model` picks another model, the turn fails with `MODEL_AUTHORIZATION_FAILED`.
- **The selection changes before the callback.** The callback settles the sign-in `accepted`, and
  the newly selected model replies. The person's Vercel Connect grant stays stored, so the next
  `getToken` for that connector returns its token.

Each turn step drops the callbacks whose sign-in has closed, so a later turn never reads an old
decline or an unused code.

A fallback needs no new API:

```ts
import { interactions } from "eve/events";

const model = defineDynamic((ctx) => {
  const declined = interactions(ctx.view).some(
    (interaction) =>
      interaction.turnId === ctx.turn?.id &&
      interaction.request.signIn?.grant === "vercel/myagent" &&
      interaction.outcome === "declined",
  );
  return declined ? "anthropic/claude-sonnet-5" : ownGateway;
});
```

### Sign-in name

`signIn.name` is `eve__model__` followed by `authKey`, or by the Vercel Connect connector with
each run of characters outside `A-Z a-z 0-9 _ . : -` replaced by `_`: `vercel/myagent` becomes
`eve__model__vercel_myagent`. eve reserves the `eve__` namespace, so the sign-in can't collide with
a tool or a connection. The sign-in card shows `auth.displayName`, or the challenge's `displayName`
when `auth` has none.

The sign-in name comes from the credential, never from the model `id`. It keys the token cache,
the callback match, and the rule that opens at most one sign-in per name in a turn, so definitions
with the same `authKey` share one sign-in and one token. `defineModel` throws when `auth` has
neither a connector nor an `authKey`.

### A rejected credential

When the provider answers with `401`, eve drops the token, calls `auth.evict`, resolves the
credential again, and retries the call once, as MCP connections do. The retry covers the whole
model call, including a `401` the provider's stream emits, and goes through the model call's own
attempt bookkeeping. After a second `401`, eve opens
a new sign-in. When the provider rejects the credential from a sign-in in the same step, the turn
fails with `MODEL_AUTHORIZATION_FAILED`. Other statuses, such as `402` or `403`, fail the call as
any provider error does. eve reads the `statusCode` on the model-call error, so the retry works for
any provider whose errors carry an HTTP status. A `create` that rethrows a `401` without its
`statusCode` hides it from the retry.

### When the turn gets no credential

| Case                                                                      | Turn error code              |
| ------------------------------------------------------------------------- | ---------------------------- |
| The person declines, or a message withdraws the sign-in                   | `MODEL_AUTHORIZATION_FAILED` |
| A scheduled turn, where eve opens no sign-in                              | `MODEL_AUTHORIZATION_FAILED` |
| No signed-in user for `principalType: "user"`                             | `MODEL_AUTHORIZATION_FAILED` |
| `auth` has no `startAuthorization`, or no callback URL exists for the run | `MODEL_AUTHORIZATION_FAILED` |
| `auth` throws `ConnectionAuthorizationFailedError`                        | `MODEL_AUTHORIZATION_FAILED` |
| `auth` throws another error, such as an unreachable credential service    | `MODEL_CREDENTIAL_FAILED`    |
| `create` throws or returns no language model                              | `MODEL_CREATE_FAILED`        |

The turn failure's `message` states the cause, and the settled sign-in card carries the failure
reason, such as `access_denied`. Provider errors stay `MODEL_CALL_FAILED`, so monitoring can tell a
credential service outage, a provider outage, and a bug in `create` apart. After a credential or
`create` failure, the session stays open, and the next turn opens a new sign-in. A provider error
ends the turn or the session as it does for any model. The next turn's prompt keeps the failed
turn's messages, including a message that withdrew the sign-in, and the note eve adds when a
message withdraws one.

### Subagents, compaction, and tests

- A declared subagent's sign-in reaches the root session's channel, as any child sign-in does, and
  completing it continues the child. A root copy from the built-in `agent` tool works the same way.
- In a turn, compaction's summary call reuses the turn's model and credential, and a `401` on that
  call opens a sign-in, as on the model call. Compaction between turns resolves the credential
  itself and never opens a sign-in; without a credential, the compaction fails. With
  `compaction.model` set, compaction never resolves the turn model's credential.
- When eve can't rerun the dynamic `model` function that returned a `defineModel` value, such as
  after a restart between turns, the call fails. eve never runs it on the project's credential.
- When eve mocks authored models (`NODE_ENV=test` or `EVE_MOCK_AUTHORED_MODELS=1`), it replaces a
  `defineModel` before `auth` runs, so tests stay offline. E2E fixtures author their own mock: a
  scripted `defineInteractiveAuthorization` and a `create` that returns a mock model.

### Secrets

The token passes from `auth` to `create` through the step's in-memory token cache only, as a
connection's token does. It never reaches memos, session state, or stream events. The session
records the model's `id`.

## Design

The rule: when the author's code makes the outbound request, the author calls a `getToken` method.
When eve makes it, `auth` is a field, and eve resolves it at the call.

| Uses the credential      | Where `auth` lives                      | What waits on the sign-in  |
| ------------------------ | --------------------------------------- | -------------------------- |
| Connection tool call     | `auth` on the connection                | The call                   |
| Authored tool            | `ctx.getToken(provider)` in `execute`   | The call                   |
| Approval response policy | `auth.getToken(provider)` in the policy | The response               |
| Model (proposed)         | `auth` on `defineModel`                 | The turn's next model call |

```text
dynamic functions ─▶ limits.sessionUsage ─▶ resolve credential ─▶ model.requested ─▶ provider call
                                              ▲     │ missing                             │ 401
                                              │     ▼                                     ▼
                                              │  sign-in opens, turn pauses ◀── second 401 ◀─ retry once
                                              │     │ callback
                                              │     ▼
                                              └─ step runs again from the start
```

The change adds three turn failure codes: `MODEL_AUTHORIZATION_FAILED`, `MODEL_CREDENTIAL_FAILED`,
and `MODEL_CREATE_FAILED`. The stream gains no event types and no fields. The changes sit in model
resolution, the model-call stage, and sign-in intake.

## Decisions and alternatives considered

- **`defineModel` is stable** and ships in `eve/models`. A model has one target, `EveLanguageModel`,
  so the definition needs no protocol qualifier.
- **`defineDynamic` stays the only way to vary behavior.** `defineModel` holds no per-call logic. A
  dynamic `model` function returns it, as dynamic connections return a definition with `auth`.
- **A message withdraws the sign-in**, as it does for a connection, so every channel gets a way
  out, including text-only channels without a cancel control.
- **eve retries a `401` once before it opens a sign-in**, so a token that only needs a refresh
  never interrupts the person.
- **A throwing `create` fails only the turn.** `create` is author code, like a dynamic `model`
  function, and a throwing dynamic function fails only its turn; the session stays open.
- **`compaction.model` and `auto()`'s decision model reject it**, because their separate calls
  can't open a sign-in of their own.
- **Not an `auth` option on `anthropic()` and `openai()`.** One definition covers every provider,
  and an `auth` option adds provider-specific surface.
- **Not a provider connection file**, such as `agent/connections/anthropic.ts`. A connection
  describes an external server's tools, and a provider connection file also requires a new rule
  that maps model IDs to connections.
- **Not a hook that checks the credential before each turn.** The hook runs once per turn, so it
  misses a credential that expires mid-turn, and it splits one provider across two files.

### `ctx.getToken()` in the dynamic `model` function

The closest alternative gives the dynamic `model` function the method that tools have:

```ts
const model = defineDynamic(async (ctx) => {
  const { token } = await ctx.getToken(connect("vercel/myagent"));
  return createGateway({ apiKey: token, teamIdOrSlug: "acme" })("anthropic/claude-sonnet-5");
});
```

It adds no definition and lets the credential inform the choice of model. But eve also runs the
function where it can't pause a turn, such as when it reloads a session's definitions or compacts
between turns, and the returned model closes over the token. A `401` then reaches eve after the
function returned, so eve can't tell which credential to drop or how to rebuild the model.
`defineModel` keeps `auth` and `create` together at the call.

## Coverage

E2E evals in `agent-tools-hitl` use a `defineModel` whose `auth` is a scripted
`defineInteractiveAuthorization`:

- A missing credential opens a sign-in, and the same turn replies after the callback.
- A declined sign-in fails the turn with `MODEL_AUTHORIZATION_FAILED`, and the next turn asks again.
- A dynamic function falls back to another model after a decline.
- A declared subagent's sign-in reaches the root session, and the child answers after the callback.

Integration tests cover the `401` retry, a selection change before the callback, a scheduled turn,
`auth` and `create` errors, a message during the sign-in, and the mock that replaces a
`defineModel`. The docs change in `docs/agent-config.md`, `docs/dynamic-configuration/index.md`,
`docs/connections/index.mdx`, and `docs/reference/typescript-api.md`. The changeset is `minor`.
