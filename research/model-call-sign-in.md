---
issue: https://github.com/vercel/eve/issues/6408
status: in-progress
last_updated: "2026-11-13"
---

# Sign in before a model call

## Summary

Some agents need the caller's own credential for the model call itself. For example, an agent
that bills each person's model usage to that person's provider account needs their API key
before the first model call. eve starts a sign-in only when a tool asks for a token, and the
model call runs before any tool.

Tools already call `ctx.getToken(provider)` and `ctx.requireAuth(provider)`. This proposal adds
both to the context of `defineDynamic`. A dynamic `model` then gets the caller's token before
each model call, and eve runs the same sign-in flow as for a tool.

## Authoring API

```ts title="agent/agent.ts"
import { createAnthropic } from "@ai-sdk/anthropic";
import { defineAgent, defineDynamic } from "eve";
import {
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
} from "eve/connections";

// Each person enters their own Anthropic API key on a page in your app.
const anthropicKey = defineInteractiveAuthorization({
  displayName: "Anthropic",
  getToken: async ({ principal }) => {
    const key = await loadAnthropicKey(principal);
    if (!key) throw new ConnectionAuthorizationRequiredError("anthropic");
    return { token: key };
  },
  // The page saves the key, then redirects to `callbackUrl`.
  startAuthorization: async ({ callbackUrl }) => ({
    challenge: { url: anthropicKeyPageUrl(callbackUrl) },
  }),
  completeAuthorization: async ({ principal }) => ({
    token: (await loadAnthropicKey(principal))!,
  }),
});

export default defineAgent({
  model: defineDynamic(async (ctx) => {
    const { token } = await ctx.getToken(anthropicKey, { authKey: "anthropic" });
    return createAnthropic({ apiKey: token })("claude-sonnet-4-5");
  }),
});
```

| Method                                | Behavior                                                    |
| ------------------------------------- | ----------------------------------------------------------- |
| `ctx.getToken(provider, options?)`    | Returns the caller's token, or starts a sign-in.            |
| `ctx.requireAuth(provider, options?)` | Drops the cached token and starts a sign-in. Never returns. |

Both accept the same providers and options as their tool counterparts, and share eve's token
cache and callback route. eve keys these sign-ins under the agent, not under a tool:
`connect("x/y")` becomes `agent__x_y`.

eve doesn't read provider errors. When a provider rejects a token, the app calls
`ctx.requireAuth(provider)`, for example from AI SDK middleware around the model.

## Semantics

| Situation                                       | What eve does                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| The caller has a token                          | eve runs the model call with it.                                                 |
| The caller has no token                         | eve opens the sign-in and pauses the turn before the model call.                 |
| The caller signs in                             | eve evaluates the model again and runs the model call in the same turn.          |
| The app calls `requireAuth` during a model call | eve ends that model call as `abandoned`, opens the sign-in, and pauses the turn. |
| The provider rejects the token from sign-in     | eve fails the turn with `token_rejected_after_authorization`.                    |
| A schedule started the turn                     | eve fails the turn with `sign_in_unavailable` and opens no sign-in.              |
| A new message arrives during the sign-in        | eve withdraws the sign-in, as for a tool's sign-in.                              |
| The caller declined or cancelled this sign-in   | eve fails the turn with the sign-in's reason and doesn't ask again in this turn. |
| A subagent needs the sign-in                    | eve passes it to the parent, as for a subagent tool's sign-in.                   |

eve saves the turn's input with the sign-in, the same way the session usage limit pauses a turn,
so the resumed turn reads the same prompt.

```text
turn.started ─▶ evaluate dynamic values ─┬─ token ────▶ model.requested ─▶ …
                                         └─ no token ─▶ interaction.opened (sign-in)
                                                         turn.paused
sign-in callback ─▶ interaction.settled (accepted) ─▶ evaluate again ─▶ model.requested ─▶ …
```

## Boundaries

- Dynamic values and model calls hand authorization errors to the same handler as tools. The
  sign-in, its channel cards and its callback stay the same.
- The protocol stays the same. Sign-ins already accept a turn as their subject.
- When eve rebuilds a remote agent's credentials for a subagent, no sign-in can run, so
  `getToken` throws there.
- Call `getToken` outside `ctx.memo`. A memo keeps its result in the session; eve already reuses
  the token within a step.
