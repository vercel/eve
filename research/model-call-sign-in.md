---
issue: https://github.com/vercel/eve/issues/6408
status: in-progress
last_updated: "2026-11-13"
---

# Sign in before a model call

Some agents need the caller's own credential for the model call itself, such as each person's own
provider API key. eve starts a sign-in only when a tool asks for a token, and the model call runs
before any tool. This proposal gives dynamic values the `ctx.getToken` and `ctx.requireAuth`
methods of tools, so a dynamic `model` can require a sign-in.

## Authoring API

```ts
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

Both accept the same providers and options as their tool counterparts. eve doesn't read provider
errors: the app calls `ctx.requireAuth` when its provider rejects a token.

## Semantics

| Situation                                       | What eve does                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| The caller has no token                         | eve opens the sign-in and pauses the turn before the model call.              |
| The caller signs in                             | eve evaluates the model again and runs the model call in the same turn.       |
| The app calls `requireAuth` during a model call | eve ends that model call as `abandoned`, then asks for the sign-in.           |
| A new message arrives during the sign-in        | The message waits for the sign-in, and history keeps it if the sign-in fails. |
| A schedule started the turn                     | eve fails the turn with `SIGN_IN_FAILED` and opens no sign-in.                |
| The caller declines, or the sign-in fails       | The card settles `declined` or `failed`, and the turn fails `SIGN_IN_FAILED`. |
| The provider rejects the token from sign-in     | eve fails the turn with `SIGN_IN_FAILED` and doesn't ask again.               |

## Boundaries

- Model calls hand sign-in errors to the same handler as tools. The cards, the callback route and
  the protocol stay the same: sign-ins already accept a turn as their subject.
- Without an `authKey`, eve keys a dynamic value's sign-in under `eve:dynamic`, and a provider
  without Connect metadata under its dynamic value. An `authKey` replaces that key, so every tool,
  connection and dynamic value with the same `authKey` shares one token.
- A step's restore reads tokens but never completes or opens a sign-in, so the guard against a
  rejected fresh token holds in a fresh process.
- Rebuilding a remote agent's credentials runs no sign-in, so `getToken` throws there.
