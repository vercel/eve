---
issue: https://github.com/vercel/eve/issues/6408
status: in-progress
last_updated: "2026-11-13"
---

# Sign in before a model call

## Summary

A turn can need the caller's own credential before its first model call, such as a model
provider credential that each person brings. eve's sign-in flow starts only from a tool call, so
an agent has no way to require that credential before the model runs.

This proposal gives dynamic values the `ctx.getToken(provider)` and `ctx.requireAuth(provider)`
that tools already have. A sign-in that either one needs, before or during the model call, pauses
the turn on that sign-in. The model call runs once the caller signs in.

## Authoring API

```ts title="agent/agent.ts"
import { createAnthropic } from "@ai-sdk/anthropic";
import { connect } from "@vercel/connect/eve";
import { defineAgent, defineDynamic } from "eve";

const anthropic = connect("anthropic/myagent");

export default defineAgent({
  model: defineDynamic(async (ctx) => {
    const { token } = await ctx.getToken(anthropic);
    return createAnthropic({ apiKey: token })("claude-sonnet-4-5");
  }),
});
```

`DynamicModelContext`, and so every dynamic value's context, gains two methods:

| Method                                | Behavior                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `ctx.getToken(provider, options?)`    | Returns the caller's token, or asks for a sign-in when the caller has none. |
| `ctx.requireAuth(provider, options?)` | Evicts the cached token and asks for a fresh sign-in. Never returns.        |

Both take the same providers and options as a tool's `ctx.getToken`: `connect("...")`, a custom
interactive definition, or a plain `{ getToken }`. They share eve's token cache and callback
route. A dynamic value's providers sign in under the `agent` scope, so the sign-in for
`connect("x/y")` is `agent__x_y`.

eve never inspects provider errors. The app maps a provider's rejection to
`ctx.requireAuth(provider)`, for example in AI SDK middleware around the model it returns.

## Semantics

| Situation                                   | What eve does                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Token present                               | The model call runs with it.                                                                       |
| No token, before the model call             | No model run starts. eve opens a sign-in with a turn subject and pauses the turn.                  |
| Caller signs in                             | The sign-in settles `accepted`. The same turn evaluates the model again and runs the model call.   |
| `requireAuth` during the model call         | eve abandons that model run (`model.settled` `abandoned`), opens the sign-in, and pauses the turn. |
| Provider rejects the token just issued      | The turn fails with `reason: "token_rejected_after_authorization"`.                                |
| Scheduled turn                              | The turn fails with `reason: "sign_in_unavailable"`. eve opens no sign-in.                         |
| A message arrives while the sign-in is open | The message withdraws the sign-in, as it does for a tool's sign-in.                                |
| Sign-in declined or cancelled in this turn  | The turn fails with the sign-in's reason. eve doesn't ask again in this turn.                      |
| Subagent                                    | eve relays the child's sign-in to the parent on the same path as a child's tool sign-in.           |

The turn's input parks with the sign-in, as it does at the session usage gate, so the resumed
turn reads the same prompt.

```text
turn.started ─▶ evaluate dynamic values ─┬─ token ──────────▶ model.requested ─▶ …
                                         └─ sign-in needed ─▶ interaction.opened (sign-in)
                                                               turn.paused
callback ─▶ interaction.settled (accepted) ─▶ evaluate again ─▶ model.requested ─▶ …
```

## Boundaries

- Authorization-required errors from dynamic values and the model call reach the same
  `handleAuthorizationError` as tools. The sign-in itself, its channels' cards, and its callback
  are unchanged.
- The protocol is unchanged. Sign-ins already accept a `turnId` subject.
- A value that rebuilds a remote agent's credentials for a child runs without a sign-in, so its
  `getToken` throws.
- `ctx.memo` keeps results in the session. Authors call `getToken` outside a memo; eve reuses
  the token within a step.
