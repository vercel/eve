---
issue: https://github.com/vercel/eve/pull/6551
status: proposed
last_updated: "2026-11-18"
---

# Per-user model credentials

> **AI status:** Written entirely by AI; human review pending.

## Context

A connection can act with a person's own account. It declares `auth`, and when the person has no
credential yet, eve opens a sign-in, holds the turn, and continues it after the person connects.
Some agents need the same for the model call itself, for example to send each person's AI Gateway
requests with that person's own Vercel access token.

## Problem

The model call has no way to ask the person to sign in. A dynamic `model` function can build a
provider model from a person's token, but when the token doesn't exist yet, the turn fails, and
the person never sees a sign-in.

## Root cause

eve resolves credentials only for connections and tools. A model is a model ID or a provider
instance, and neither can declare `auth`, so eve has nothing to resolve or ask for before the
model call.

## Solution

A new definition, `defineModel`, puts a connection-style `auth` on a model. eve resolves that
credential before each model call and opens the connection sign-in when it is missing.

## Flow

1. The agent's `model` is a `defineModel` value, directly or from a dynamic `model` function.
2. Before each model call, eve calls `auth.getToken` for the current person.
3. When the person has no credential, eve opens the sign-in and holds the turn.
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
| `authKey` | `string`                                        | Keys the credential for the sign-in. Required when `auth` has no Vercel Connect connector, and optional otherwise. See [Sign-in name and label](#sign-in-name-and-label).                                               |

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

- `auth` doesn't take the per-caller function form that a connection's `auth` does. Choose per
  caller in `defineDynamic`.
- `auth` is a plain definition, so an author adjusts it by spreading it, as connections do for
  `displayName`. Wrapping `startAuthorization` this way can add a parameter to the sign-in link.
  The spread keeps the Vercel Connect connector, so the sign-in name stays the same.
- An `id` the catalog doesn't list needs `modelContextWindowTokens`, set where any other model
  instance sets it.
- `DynamicModelContext` gains no token methods, and `anthropic()` and `openai()` from
  `eve/models/*` don't change. Authors bring their own provider in `create`.

## Behavior

### Resolving the credential

eve resolves `auth` before each model call that uses the model: after dynamic functions run and
`limits.sessionUsage` is checked, and before `model.requested`. A turn that waits on a sign-in
therefore has no model run open.

That order is a change. Today eve applies `model.requested` first and resolves the model after it,
and a failure there ends the session with `MODEL_SELECTION_FAILED`. Model resolution moves ahead of
`model.requested` for every model, and the credential step is part of it. A missing credential never
takes the `MODEL_SELECTION_FAILED` path: it opens a sign-in or fails the turn, as the next sections
describe. A `create` that throws fails the turn with `MODEL_CREATE_FAILED` and leaves the session
open. Existing agents see one difference: a model that fails to resolve no longer leaves a requested
run on the stream.

Resolution follows the connection rules. `principalType: "user"` reads the session's current user
and keeps each user's token separate. `principalType: "app"` never asks anyone to sign in. A model
has no server URL, so eve calls the `auth` callbacks with `connection: { url: "" }`, as it does
for a tool's inline auth. eve passes the resolved `TokenResult` to `create` and calls the model it
returns.

### Missing credential

`auth` is interactive when it has `startAuthorization` and `completeAuthorization`. When
`getToken` on an interactive `auth` throws `ConnectionAuthorizationRequiredError`, eve starts the
authorization and opens the sign-in a connection opens: `interaction.opened` with
`request.kind: "sign-in"`, the turn as its subject, and the challenge in `request.signIn`. Channels
show it with the sign-in prompt they already have. The turn stays open under the same `turnId`.

When the callback arrives, the step runs again from the start. Dynamic functions run, eve
completes the authorization with the selected model's `auth`, settles the sign-in as `accepted`,
and makes the model call with the new credential.

A callback can also report that no credential came. eve settles the model's sign-in as it settles
a tool call's: `declined` when the provider reports `access_denied`, and `failed` with the
provider's reason otherwise. Today that mapping applies only to a sign-in that a call owns.

eve matches the callback to the selected model by sign-in name. The dynamic function may now
select a model with a different sign-in name, or one without `auth`. eve can't complete the
authorization then: only the `auth` that started it can, and eve holds no definition but the one
the function returned. eve continues with the selected model, which resolves its own credential,
and settles the open sign-in `interrupted` with reason `turn-ended` when the turn ends.
A Vercel Connect grant is not lost: `connect(...)` completes by reading the token again, so the
next `getToken` returns it. An `auth` that redeems a one-time code in `completeAuthorization` does
lose that consent, and asks again.

### Sign-in name and label

`signIn.name` is `eve__model__` followed by `authKey`, or by the Vercel Connect connector when
there is no `authKey`. eve cleans a connector as it does for a tool's inline auth, so
`vercel/myagent` becomes `eve__model__vercel_myagent`. eve reserves the `eve__` namespace,
so the name can't collide with a tool or a connection.

The name never comes from the model `id`. It keys the token cache, the callback match, and the
rule against asking twice, so definitions that share a name share one sign-in and one cached
token. `defineModel` throws when `auth` has neither a connector nor an `authKey`. Two definitions
that use one connector with different token parameters need different `authKey` values. `authKey`
takes the characters a tool's `authKey` option takes.

The label people see is `auth.displayName`, then the challenge's `displayName`, then the fallback
channels already derive from the name's last segment: "Vercel myagent" here.

### While the sign-in is open

The sign-in behaves as a connection sign-in does. It keeps the turn open until the person
connects, the turn is cancelled, or the person sends another message. That message steers the
turn: the sign-in ends as `withdrawn`, and the step runs again with the message in the turn.

### When no credential arrives

A sign-in can end without a credential: the person declines, the provider fails it, or a new
message withdraws it. eve settles the sign-in before the dynamic functions run, so a
dynamic `model` function can read the outcome from `ctx.view` and return a different model, which
then answers. If the selected model needs the same credential for the same user, eve follows the
connection rule and doesn't ask again in that turn.

Some turns never ask:

| Case                                                                           | Turn error code              |
| ------------------------------------------------------------------------------ | ---------------------------- |
| A scheduled turn                                                               | `MODEL_AUTHORIZATION_FAILED` |
| No signed-in user for `principalType: "user"`                                  | `MODEL_AUTHORIZATION_FAILED` |
| No callback URL for the run                                                    | `MODEL_AUTHORIZATION_FAILED` |
| `auth` has no `startAuthorization`                                             | `MODEL_AUTHORIZATION_FAILED` |
| `getToken` or `startAuthorization` throws `ConnectionAuthorizationFailedError` | `MODEL_AUTHORIZATION_FAILED` |
| Either throws another error, such as an unreachable credential service         | `MODEL_CREDENTIAL_FAILED`    |

A turn left without the credential fails with a new code, `MODEL_AUTHORIZATION_FAILED`, whether
its sign-in ended without one or was never asked. Its `message` states why, and a settled sign-in
card carries the reason code connection sign-ins use, such as `access_denied`. An unexpected error
from `auth` fails the turn with a second new code, `MODEL_CREDENTIAL_FAILED`, and a provider error
stays `MODEL_CALL_FAILED`, so monitoring can tell a credential service outage from a provider
outage. The session stays open, and the next turn asks again. A failed turn's input is not
replayed, and that includes a message that withdrew the sign-in.

Falling back needs no new API. The settled sign-in is in `ctx.view`:

```ts
import { interactions } from "eve/events";

const model = defineDynamic((ctx) => {
  const refused = interactions(ctx.view).some(
    (asked) =>
      asked.turnId === ctx.turn?.id &&
      asked.request.signIn?.grant === "vercel/myagent" &&
      asked.status === "settled" &&
      asked.outcome !== "accepted",
  );
  return refused ? "anthropic/claude-sonnet-5" : ownGateway;
});
```

### A rejected credential

When the provider answers a `ModelDefinition`'s call with `401`, eve does what an MCP connection
does. It drops the token, calls `auth.evict`, resolves the credential again, and retries the call
once. If resolving now requires a sign-in, or the provider rejects the retried call too, eve asks
the person to sign in again. A credential the provider rejects right after that sign-in fails the
turn with `MODEL_AUTHORIZATION_FAILED`.

This retry is new for model calls. Today the harness treats a `401` as terminal, and the only
retries are inside clients: MCP connections, eve's local-development AI Gateway transport, and
`chatgpt()`. eve recognizes the `401` by the `statusCode` it already reads from model-call errors,
so it needs nothing specific to a provider.

Only a `401` takes this path. Any other status, such as `402` or `403`, fails the call as it does
today. A turn that can't ask, such as a scheduled one, fails with the code listed under
[When no credential arrives](#when-no-credential-arrives).

`create` can return a wrapped model, such as one with AI SDK middleware. A wrapper that replaces a
`401` error hides it from this path.

### Subagents, copies, and other model calls

- A declared subagent's `agent.ts` can use `defineModel`. Its sign-in reaches the root session's
  channel as any child sign-in does, and completing it continues the child.
- A copy started by the built-in `agent` tool runs the root's `model` in its own session. It
  resolves the credential there, and its sign-in reaches the root session the same way. An
  `agent({ models })` option that is a `ModelDefinition` behaves the same.
- In a turn, compaction's summary call reuses the model the turn already resolved when
  `compaction.model` is unset, so it has no credential step of its own.
- Compaction requested between turns resolves the model itself, with no turn to hold. It resolves
  the credential through `getToken` and never opens a sign-in. Without a credential, that
  compaction settles `failed` with `compaction-failed`, as any failed compaction does.

### Secrets

The token passes from `auth` to `create` and nowhere else. eve keeps it in the step's in-memory
token cache that connections use, never in memos, session state, or stream events. The session
records the model's `id`, not the model `create` returned.

## Design

The rule this follows: when the author's code makes the outbound request, auth is a `ctx` method.
When eve makes it, auth is a field, and eve resolves it at the call.

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

Invariants:

- eve never passes a token to a dynamic function. Selecting a model needs no credential, so
  restoring or re-reading the selection works without one.
- A `ModelDefinition` reaches a provider only through the credential step, whichever field
  supplied it.
- The stream gains no event types and no fields. The new values are three turn failure codes:
  `MODEL_AUTHORIZATION_FAILED`, `MODEL_CREDENTIAL_FAILED`, and `MODEL_CREATE_FAILED`.
- The definitions kernel doesn't change. The harness changes are in the model-call stage: model
  resolution moves ahead of `model.requested` and gains the credential step, a `401` on a
  `ModelDefinition`'s call retries once, and a sign-in that no call or response owns settles with
  the outcomes a call's sign-in has.
- When eve mocks authored models (`NODE_ENV=test` or `EVE_MOCK_AUTHORED_MODELS=1`), it replaces a
  `defineModel` with its mock before `auth` runs, so tests stay offline. E2E fixtures author their
  own mock: a scripted `defineInteractiveAuthorization` and a `create` that returns a mock model,
  so evals cover the sign-in without a provider.

## Decisions and alternatives considered

- **`defineModel` is stable.** It ships in `eve/models` under eve's semantic-versioning promise, not
  under `eve/experimental`. Connection definitions carry their protocol in their names because eve
  has several. A model has one target, `EveLanguageModel`, so `defineModel` takes no qualifier.
- **`defineDynamic` stays the only way to vary behavior.** `defineModel` varies nothing. It is the
  definition a dynamic `model` function returns, as `defineTool` and `defineMcpClientConnection` are
  for tools and connections. Models were the one dynamic kind with no eve definition: the function
  returns a model ID or an SDK instance, and neither can declare auth. Dynamic connections already
  work this way. Their function returns a definition that carries `auth`, and eve runs `auth` when
  it makes the call.
- **The sign-in name comes from the credential, not the model.** The name keys the token cache, the
  callback match, and the rule against asking twice. All three belong to a credential, so two
  definitions with one `id` and different `auth` must not share it. eve can't detect that clash at
  runtime: the callback resumes in a fresh step, where the earlier `auth` object no longer exists to
  compare. So an `auth` without a connector identifies itself with `authKey`, as a tool's inline
  auth does.
- **A message withdraws the sign-in.** This is the connection behavior, and it gives every channel a
  way out, including text-only channels that have no cancel control. The cost: an agent with no
  fallback fails the turn, and that message is not replayed.
- **A `401` retries once before eve asks.** MCP connections do the same, and so do eve's
  local-development AI Gateway transport and `chatgpt()` inside their own clients. Asking on the
  first `401` would prompt for a token that only needed a refresh.
- **Only the model that asked completes a sign-in.** When the selection changes before the callback,
  completing anyway would need the `auth` that started the authorization, and after a restart eve
  holds no definition but the one the function returns now. So the selected model answers, and the
  open sign-in settles `interrupted` when the turn ends. That needs no new reason code.
- **One failure code per cause, and no reason field.** `MODEL_AUTHORIZATION_FAILED` covers a decline
  and a setup problem, `MODEL_CREDENTIAL_FAILED` an outage at the credential service,
  `MODEL_CREATE_FAILED` a bug in `create`, and `MODEL_CALL_FAILED` a provider error. Monitoring
  tells them apart by code. The turn error carries only `name`, `code`, `message`, `id`, and `hint`,
  so a reason field adds a field to every error event.
- **A throwing `create` keeps the session.** `create` is author code, like a dynamic `model`
  function, and a throwing dynamic function fails only its turn. `MODEL_SELECTION_FAILED` ends the
  session over a bug that a redeploy fixes.
- **Every turn model accepts it.** `auto()` and `agent({ models })` validate their options with one
  function, and each option becomes a session's turn model, which can hold for a sign-in. Compaction
  and decision calls can't hold a turn, so they reject it.
- **Not an `auth` option on `anthropic()` and `openai()`.** That adds provider-specific surface for
  something one definition expresses for every provider.
- **Not a provider connection file**, such as `agent/connections/anthropic.ts`, with `model` left as
  a string ID. A connection is defined as the tools of an external server, eve would need a rule
  that maps model IDs to connections, and an arbitrary provider still needs a factory.
- **Not a turn gate from a hook**, where a `turn.started` handler requests the sign-in and the
  dynamic function reads the token itself. It checks once per turn, so a credential revoked mid-turn
  is unhandled, and it splits one provider across two files.

### `ctx.getToken()` in the dynamic `model` function

The closest alternative gives the dynamic `model` function the method that tools have:

```ts
const model = defineDynamic(async (ctx) => {
  const { token } = await ctx.getToken(connect("vercel/myagent"));
  return createGateway({ apiKey: token, teamIdOrSlug: "acme" })("anthropic/claude-sonnet-5");
});
```

It is a viable design. It adds no definition, reuses a method authors know, and lets the
credential inform which model to choose. Both designs use the same auth definitions, and both
need the same new harness capability: a sign-in that the turn's model call owns. They differ in
what else eve must build:

| Requirement                 | `ctx.getToken()` in the function                                                                                                                                                                                                                                                                                                       | `defineModel`                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Select without a credential | The function can't finish without one, and eve also runs it outside a model call: when a fresh process restores definitions, and for a compaction step. A throw there leaves only the saved model ID, which resolves to the AI Gateway model on the project's credential. The method needs different behavior in each evaluation mode. | Selection needs no credential, so every path that restores or re-reads it works unchanged.                                                           |
| Token lifetime              | The function returns a provider model with the token inside it. eve keeps that live value in a per-session process cache and reuses it until the next evaluation. The function's documented idiom is also to save network results with `ctx.memo`.                                                                                     | The live value is the definition. The token is in the step's token cache and in the model that `create` returns for one call. `create` has no `ctx`. |
| Recover from a `401`        | A tool's `execute` sees its own `401` and calls `ctx.requireAuth()`. Here the `401` reaches eve's model call after the function has returned. eve must record which providers the function read, evict them, and run the function again.                                                                                               | `auth` and `create` stay linked at the call, so eve evicts the token, resolves again, and rebuilds the model.                                        |
| Suspend the turn            | Needs a path through definition evaluation that tells a missing credential from `REACTION_FAILED`.                                                                                                                                                                                                                                     | Happens in the model-call stage, where eve already holds a turn for a runtime limit.                                                                 |

`defineModel` also can't be sugar for a `defineDynamic` that calls `ctx.getToken()`. A dynamic
value can't be returned from a dynamic function, so one function couldn't choose between a
credentialed model and a Gateway model ID, and the value couldn't be an `auto()` or
`agent({ models })` option. It has to be a value the function returns.

`defineModel` gives up two things. The credential eve resolves can't inform the choice of model.
And other dynamic values, such as instructions, can't ask for a sign-in. That second one is a
larger feature, any dynamic value suspending a turn, and deserves its own design.

## Coverage

E2E evals run on a fixture whose `model` is a `defineModel` value over a deterministic
`defineInteractiveAuthorization` provider, as `agent-tools-hitl` uses for tool sign-ins:

- A missing credential opens a sign-in, and the same turn replies after the callback.
- A declined sign-in fails the turn with `MODEL_AUTHORIZATION_FAILED`, and the next turn asks
  again.
- A dynamic function falls back to another model after a decline.
- A declared subagent's sign-in reaches the root session, and the child answers after the
  callback.

Integration tests cover the rest: the `401` retry, which needs a provider response, a selection
that changes before the callback, a scheduled turn, `auth` and `create` errors, a message during
the sign-in with and without a fallback, and the mock that replaces a `defineModel`. Docs change in
`docs/agent-config.md`, `docs/dynamic-configuration/index.md`, the sign-in sections of
`docs/connections/index.mdx`, and the export table in `docs/reference/typescript-api.md`. The
changeset is `minor`.
