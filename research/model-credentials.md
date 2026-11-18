---
issue: https://github.com/vercel/eve/pull/6551
status: proposed
last_updated: "2026-11-18"
---

# Per-user model credentials

> **AI status:** Written entirely by AI; human review pending.

## Summary

A connection can act with a person's own account. It declares `auth`, and when the person has no
credential yet, eve opens a sign-in, holds the turn, and continues it after the person connects.
Some agents need the same for the model call itself, for example to send each person's AI Gateway
requests with that person's own Vercel access token.

The model call has no way to ask the person to sign in. A dynamic `model` function can build a
provider model from a person's token, but when the token doesn't exist yet, the turn fails, and the
person never sees a sign-in. eve resolves credentials only for connections and tools, and a model
ID or provider instance can't declare `auth`.

This doc proposes `defineModel`, which puts a connection-style `auth` on a model:

1. The agent's `model` is a `defineModel` value, directly or from a dynamic `model` function.
2. Before each model call, eve calls `auth.getToken` for the current person.
3. When the person has no credential, eve opens the connection sign-in and holds the turn.
4. After the person connects, the same turn continues. eve passes the token to `create` and calls
   the model it returns.

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

To ask only signed-in people, choose the model per session with `defineDynamic`:

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

`defineModel` takes and returns a `ModelDefinition`, also exported from `eve/models`. `id`, `auth`,
and `create` are always required:

| Field     | Type                                            | Purpose                                                                                                                                                                                                                 |
| --------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`      | `string`                                        | Identifies the model. eve reports it on `model.started` and as `ctx.model.id`, and looks it up in the AI Gateway model catalog for the context window. eve needs it during model selection, before a credential exists. |
| `auth`    | `AuthorizationDefinition`                       | The credential strategy: `connect(...)` from `@vercel/connect/eve`, `defineInteractiveAuthorization(...)`, or `{ getToken }`, as on a connection.                                                                       |
| `create`  | `(credential: TokenResult) => EveLanguageModel` | Builds the provider model from the credential. It is synchronous; I/O belongs in `auth.getToken`.                                                                                                                       |
| `authKey` | `string`                                        | Keys the credential for the sign-in. Required when `auth` has no Vercel Connect connector, and optional otherwise. See [Sign-in name](#sign-in-name).                                                                   |

eve accepts a `ModelDefinition` wherever it takes the model for a session's turns:

- `defineAgent({ model })` on the root agent and on a declared subagent.
  `defineAgent({ model: ownGateway })` makes every caller use their own credential.
- The result of `defineDynamic`, directly or as `model` in a selection object.
- `auto()` `options` and `fallback`, and `agent({ models })` options.

eve rejects it where it calls a model outside a turn's own run, or needs a serializable model:

- `compaction.model` and the decision `model` of `auto()` reject it with a definition error.
- `ctx.agent(name, { model })` rejects it as it rejects any provider model.
- A dynamic subagent's returned config rejects it as it rejects any provider model. eve saves
  that selection with the session, so it must be a model ID. `ctx.model.id` is the `id`, so
  passing it on selects the AI Gateway model with that ID on the project's credential.

More rules:

- `auth` takes one definition. To vary it per caller, return a different `defineModel` value from
  `defineDynamic`.
- `auth` is a plain definition, so an author adjusts it by spreading it, as connections do for
  `displayName`. Wrapping `startAuthorization` this way can add a parameter to the sign-in link.
  The spread keeps the Vercel Connect connector, so the sign-in name stays the same.
- An `id` outside the catalog needs `modelContextWindowTokens`, set as for any other model instance.
- `DynamicModelContext` gains no token methods, and `anthropic()` and `openai()` from
  `eve/models/*` don't change. Authors bring their own provider in `create`.

## Behavior

### Before each model call

eve resolves `auth` after dynamic functions run and `limits.sessionUsage` passes, and before
`model.requested`, so a turn that waits on a sign-in has no open model run. Model resolution moves
ahead of `model.requested` for every model. Existing agents see one difference: a model that fails
to resolve leaves no requested run on the stream.

Resolution follows the connection rules. `principalType: "user"` reads the session's current user
and keeps each user's token separate, and `principalType: "app"` never asks anyone to sign in. A
model has no server URL, so eve passes `connection: { url: "" }` to the `auth` callbacks, as it does
for a tool's inline auth. eve passes the `TokenResult` to `create` and calls the returned model.

### The sign-in

When `getToken` throws `ConnectionAuthorizationRequiredError` and `auth` has
`startAuthorization`, eve opens the sign-in a connection opens: `interaction.opened` with
`request.kind: "sign-in"` and the turn as its subject. Channels show their existing sign-in prompt,
and the turn holds under the same `turnId`.

- **The person connects.** The step runs again from the start. The dynamic functions run, eve
  completes the authorization with the selected model's `auth`, settles the sign-in `accepted`, and
  calls the model.
- **The person declines.** eve settles the sign-in `declined` before the dynamic functions run, so
  a dynamic `model` can read the decline from `ctx.view` and return another model.
- **The person sends a message.** The sign-in ends `withdrawn`, and the step runs again with the
  message in the turn.
- **The selection changes before the callback.** Only the `auth` that started the authorization can
  complete it, so the newly selected model answers. eve settles the open sign-in `interrupted` when
  the turn ends. A Vercel Connect grant survives, because the next `getToken` reads it.

A fallback needs no new API:

```ts
import { interactions } from "eve/events";

const model = defineDynamic((ctx) => {
  const declined = interactions(ctx.view).some(
    (asked) =>
      asked.turnId === ctx.turn?.id &&
      asked.request.signIn?.grant === "vercel/myagent" &&
      asked.outcome === "declined",
  );
  return declined ? "anthropic/claude-sonnet-5" : ownGateway;
});
```

### Sign-in name

`signIn.name` is `eve__model__` followed by `authKey`, or by the cleaned Vercel Connect connector:
`vercel/myagent` becomes `eve__model__vercel_myagent`. eve reserves the `eve__` namespace, so the
sign-in can't collide with a tool or a connection. The card shows `auth.displayName`, then the
challenge's `displayName`.

The sign-in name comes from the credential, never from the model `id`. It keys the token cache,
the callback match, and the rule against asking twice in a turn, so definitions with one `authKey`
share one sign-in and one token. `defineModel` throws when `auth` has neither a connector nor an
`authKey`.

### When the turn gets no credential

| Case                                                                      | Turn error code              |
| ------------------------------------------------------------------------- | ---------------------------- |
| The person declines, or a message withdraws the sign-in                   | `MODEL_AUTHORIZATION_FAILED` |
| A scheduled turn, which can't ask                                         | `MODEL_AUTHORIZATION_FAILED` |
| No signed-in user for `principalType: "user"`                             | `MODEL_AUTHORIZATION_FAILED` |
| `auth` has no `startAuthorization`, or no callback URL exists for the run | `MODEL_AUTHORIZATION_FAILED` |
| `auth` throws `ConnectionAuthorizationFailedError`                        | `MODEL_AUTHORIZATION_FAILED` |
| `auth` throws another error, such as an unreachable credential service    | `MODEL_CREDENTIAL_FAILED`    |
| `create` throws or returns no language model                              | `MODEL_CREATE_FAILED`        |

The turn's `message` states the cause, and a settled sign-in card carries the connection reason,
such as `access_denied`. Provider errors stay `MODEL_CALL_FAILED`, so monitoring can tell a
credential service outage, a provider outage, and a bug in `create` apart. The session stays open
in every case, and the next turn asks again. eve doesn't replay a failed turn's input, including a
message that withdrew the sign-in.

### A rejected credential

When the provider answers with `401`, eve drops the token, calls `auth.evict`, resolves the
credential again, and retries the call once. A second `401` asks the person to sign in again. A
credential that the provider rejects right after a sign-in fails the turn with
`MODEL_AUTHORIZATION_FAILED`. Other statuses, such as `402` or `403`, fail the call as they do
today. eve reads the `statusCode` it already reads from model-call errors, so the retry works for
every provider. A `create` that wraps the model in middleware that replaces a `401` hides it from
the retry.

### Subagents, compaction, and tests

- A declared subagent's sign-in reaches the root session's channel, as any child sign-in does, and
  completing it continues the child. A copy from the built-in `agent` tool works the same way.
- In a turn, compaction's summary call reuses the turn's model and credential. Compaction between
  turns resolves the credential itself and never opens a sign-in; without one, the compaction fails.
- A reference from a `defineModel` selection resolves only with the definition. A fresh process
  that can't rebuild the selection fails the call, so the call never runs on the project's
  credential.
- When eve mocks authored models (`NODE_ENV=test` or `EVE_MOCK_AUTHORED_MODELS=1`), it replaces a
  `defineModel` before `auth` runs, so tests stay offline. E2E fixtures author their own mock: a
  scripted `defineInteractiveAuthorization` and a `create` that returns a mock model.

### Secrets

The token passes from `auth` to `create` and nowhere else. It lives in the step's in-memory token
cache, as a connection's token does, and never in memos, session state, or stream events. The
session records the model's `id`.

## Design

The rule: when the author's code makes the outbound request, auth is a `ctx` method. When eve makes
it, auth is a field, and eve resolves it at the call.

| Uses the credential      | Declared as                             | What waits on the sign-in  |
| ------------------------ | --------------------------------------- | -------------------------- |
| Connection tool call     | `auth` on the connection                | The call                   |
| Authored tool            | `ctx.getToken(provider)` in `execute`   | The call                   |
| Approval response policy | `auth.getToken(provider)` in the policy | The response               |
| Model (proposed)         | `auth` on `defineModel`                 | The turn's next model call |

```text
dynamic functions ─▶ runtime limit ─▶ resolve credential ─▶ model.requested ─▶ provider call
                                        ▲      │ missing                            │ 401
                                        │      ▼                                    │
                                        │   sign-in opens, turn holds               │
                                        │      │ callback                           │
                                        │      ▼                                    │
                                        │   step runs again from the start          │
                                        │                                           │
                                        └────────── drop token, once ◀──────────────┘
```

The stream gains no event types and no fields. The new values are three turn failure codes:
`MODEL_AUTHORIZATION_FAILED`, `MODEL_CREDENTIAL_FAILED`, and `MODEL_CREATE_FAILED`. The definitions
kernel stays the same; the changes sit in the model-call stage.

## Decisions and alternatives considered

- **`defineModel` is stable** and ships in `eve/models`. A model has one target, `EveLanguageModel`,
  so the definition needs no protocol qualifier.
- **`defineDynamic` stays the only way to vary behavior.** `defineModel` varies nothing: it is the
  value a dynamic `model` function returns, as `defineTool` is for tools. Dynamic connections
  already work this way, with `auth` on the returned definition.
- **A message withdraws the sign-in**, as it does for a connection. Every channel gets a way out,
  including text-only channels without a cancel control.
- **A `401` retries once before eve asks**, as MCP connections do, so a token that only needs a
  refresh never prompts the person.
- **A throwing `create` keeps the session.** `create` is author code, like a dynamic `model`
  function, and a throwing dynamic function fails only its turn.
- **Compaction and decision calls reject it**, because they can't hold a turn for a sign-in.
- **Not an `auth` option on `anthropic()` and `openai()`.** That adds provider-specific surface for
  something one definition covers for every provider.
- **Not a provider connection file**, such as `agent/connections/anthropic.ts`. A connection
  describes an external server's tools, and eve needs a rule that maps model IDs to connections.
- **Not a turn gate in a hook.** It checks once per turn, so it misses a credential that expires
  mid-turn, and it splits one provider across two files.

### `ctx.getToken()` in the dynamic `model` function

The closest alternative gives the dynamic `model` function the method that tools have:

```ts
const model = defineDynamic(async (ctx) => {
  const { token } = await ctx.getToken(connect("vercel/myagent"));
  return createGateway({ apiKey: token, teamIdOrSlug: "acme" })("anthropic/claude-sonnet-5");
});
```

It adds no definition and lets the credential inform the choice of model. But eve also runs the
function where no turn can hold, such as restoring definitions and compaction, and the returned
model closes over the token. A `401` then reaches eve after the function returned, so eve can't
tell which credential to drop or how to rebuild the model. `defineModel` keeps `auth` and `create`
together at the call. It gives up one thing: the resolved credential can't inform which model to
pick.

## Coverage

E2E evals in `agent-tools-hitl` use a `defineModel` over a deterministic
`defineInteractiveAuthorization` provider:

- A missing credential opens a sign-in, and the same turn replies after the callback.
- A declined sign-in fails the turn with `MODEL_AUTHORIZATION_FAILED`, and the next turn asks again.
- A dynamic function falls back to another model after a decline.
- A declared subagent's sign-in reaches the root session, and the child answers after the callback.

Integration tests cover the `401` retry, a selection change before the callback, a scheduled turn,
`auth` and `create` errors, a message during the sign-in, and the mock that replaces a
`defineModel`. The docs change in `docs/agent-config.md`, `docs/dynamic-configuration/index.md`,
`docs/connections/index.mdx`, and `docs/reference/typescript-api.md`. The changeset is `minor`.
