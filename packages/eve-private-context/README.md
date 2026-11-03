# eve/extensions/private-context

`eve/extensions/private-context` records whose private data a session has read. An agent-wide approval policy then asks a person before writes, and denies personal reads in conversations visible outside their participants. It is a proof of concept for the derived-state proposal in [#5867](https://github.com/vercel/eve/pull/5867), and the confidentiality counterpart of `eve/extensions/taint`.

It ships inside the `eve` package. This private `@eve/private-context` workspace package is its source of truth: eve's build copies `extension/` into `packages/eve/src/extensions/private-context/extension` and publishes it as `eve/extensions/private-context`.

## Mount

```ts
// agent/extensions/private-context.ts
export { default } from "eve/extensions/private-context";

// agent/agent.ts
import { defineAgent } from "eve";
import { privateContext } from "eve/extensions/private-context";

export default defineAgent({ approval: privateContext() });
```

## Tags

eve doesn't interpret tags. The extension reads three:

| Tag               | Meaning                                                                            |
| ----------------- | ---------------------------------------------------------------------------------- |
| `reads:personal`  | The result can contain the caller's private data, read with their own credentials. |
| `effect:external` | The call changes state or sends data outside the session. Shared with taint.       |
| `effect:export`   | The call moves data somewhere bulk or persistent. Shared with taint.               |

The built-in `agent` tool has no tags, so it counts as `reads:personal` by name.

## What it contributes

- A hook (`extension/hooks/track.ts`) that keeps `private-context.personal` in `defineState`. `delivery.admitted` records the sender as `caller`. `call.requested` with `reads:personal` adds the call to `pending`. `call.settled` removes it and, if the call completed, adds `caller` (or `"unknown"`) to `owners` and the tool name to `sources`.
- `privateContextPolicy(options)`: once the session holds personal data, asks before `effect:external`, `effect:export`, and untagged connection tools that aren't `readOnlyHint: true` (`untaggedConnections`, default `"treat-as-write"`).
- `audiencePolicy(options)`: denies `reads:personal` unless `ctx.session.audience` is `"private"` (`treatUnknownAs`, default `"public"`).
- `privateContext(options)`, both combined, and `strictest(...policies)`, which keeps the strictest answer.

Behavior and limits are documented in `docs/private-context-extension.md`.

## Validate

```sh
corepack pnpm --filter @eve/private-context typecheck
node --test "packages/eve-private-context/test/unit/*.test.ts"
corepack pnpm --filter eve exec vitest run --config vitest.integration.config.ts src/extensions/private-context
```
