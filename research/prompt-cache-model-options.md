---
issue: https://github.com/vercel/eve/issues/4050
status: implemented
last_updated: "2026-10-09"
---

# Prompt cache model options

> **AI status:** Written entirely by AI; human review pending.

## Summary

eve places Anthropic prompt-cache breakpoints itself: on the last tool, the
last system message, the last message, and the latest assistant message. It
only does this for models it can identify as Anthropic from the provider name
or model id, and it always uses the default 5-minute lifetime. Two requests
follow from that:

- [#1314](https://github.com/vercel/eve/issues/1314): a Bedrock application
  inference profile has an opaque id, so eve places no breakpoints and every
  turn pays full input price.
- [#4050](https://github.com/vercel/eve/issues/4050): chat agents with pauses
  longer than five minutes rewrite the whole cache on every turn. Anthropic
  offers a 1-hour lifetime, but authors can't reach eve's breakpoints to set it.

This doc adds one per-model option that covers both.

## Authoring API

```ts
defineAgent({
  model: bedrock("arn:aws:bedrock:…:application-inference-profile/abc"),
  modelOptions: {
    promptCache: { anthropic: { ttl: "1h" } },
  },
});
```

- `promptCache.anthropic` declares that the model takes Anthropic breakpoints.
  On a model eve already recognizes, it changes nothing beyond the TTL.
  `{ anthropic: {} }` turns breakpoints on with the default lifetime.
- `ttl` is `"5m"` (default) or `"1h"`. Every breakpoint in a request gets the
  same TTL, because Anthropic rejects a 1-hour breakpoint after a 5-minute one.
  It maps to `anthropic.cacheControl.ttl` and `bedrock.cachePoint.ttl`. With no
  option set, or with `"5m"`, requests stay byte-identical to today's.
- Dynamic model selections return `promptCache` in `modelOptions`, like
  `providerOptions`, so the setting follows the model it describes when a turn
  switches models.
- eve rejects `promptCache` on AI Gateway models: at build time for a static
  model, and at selection time for a dynamic one. Gateway places its own
  breakpoints through `providerOptions.gateway.caching: "auto"` and has no TTL
  control.

## Why this shape

- **Under `modelOptions`, not the top level.** Breakpoints and TTL depend on the
  model, and dynamic resolvers already return `modelOptions` per selection.
- **Owned by eve, not `providerOptions`.** An earlier attempt (#1532) read an
  invented key inside `providerOptions.bedrock`. That key would also have been
  sent to the AI SDK. `providerOptions` stays a pure pass-through.
- **Scoped by protocol.** Nesting the TTL under `anthropic` means a TTL can't be
  set without also declaring the breakpoint protocol it belongs to. Other
  providers' cache settings, such as OpenAI's `promptCacheKey` and
  `promptCacheRetention`, apply to the whole call, so `providerOptions` already
  reaches them.

## Not included

- Separate TTLs for the stable prefix and the conversation, such as `1h` on
  tools and system and `5m` on history. Anthropic's ordering rule allows it,
  and `ttl` could later accept `{ prefix, conversation }`.
- `promptCache: false`, which would turn eve's breakpoints off. Nobody has asked
  for it yet.
- Amazon Nova on Bedrock, which also reads `cachePoint` but doesn't cache tool
  definitions.
