# eve/extensions/private-context

`eve/extensions/private-context` tracks confidentiality: how confidential the data a session read is, and whose personal data it holds. Its policies ask before data leaves for a sink whose cap is too low, and deny confidential reads in conversations that are too open. It is a proof of concept for the derived-state proposal in [#5867](https://github.com/vercel/eve/pull/5867), and the confidentiality counterpart of `eve/extensions/untrusted-content`.

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

eve doesn't interpret tags. The extension reads these, named to line up with MCP's draft annotations, SEP-2061, and FIDES:

| Tag                   | Meaning                                                                            |
| --------------------- | ---------------------------------------------------------------------------------- |
| `reads:sensitive`     | The result can contain sensitive company data (FIDES `private`).                   |
| `reads:personal`      | The result can contain the caller's private data (FIDES `user_identity`). Higher.  |
| `sink:public`         | The call can put data somewhere publicly accessible.                               |
| `sink:internal`       | The call puts data where a restricted internal audience sees it.                   |
| `sink:user`           | The call puts data where only the user it's helping sees it.                       |
| `effect:external`     | The call changes state or sends data outside the session. A sink capped at public. |
| `effect:irreversible` | The call can't be undone. A sink capped at public.                                 |

The built-in `agent` tool has no tags, so it counts as `reads:personal` by name.

## What it contributes

- A hook (`extension/hooks/track.ts`) that keeps `private-context.personal` in `defineState`. `delivery.admitted` records the sender as `caller`. `call.requested` with a read tag adds the call to `pending` with its level. `call.settled` removes it and, if the call completed, records the level: owners and sources for personal reads, sources for sensitive ones.
- `privateContextPolicy(options)`: asks before a call that would send data past its sink's cap. Personal data passes only to a `sink:user` that the user owns all of. Options: `sensitiveFlows` (default `"ask"`) and `untaggedConnections` (default `"treat-as-write"`).
- `exceedsCap(ctx)`: whether a call would exceed its cap, for `untrustedContentPolicy({ when: exceedsCap })`.
- `audiencePolicy(options)`: denies `reads:personal` unless `ctx.session.audience` is `"private"`, and `reads:sensitive` outside the workspace (`treatUnknownAs`, default `"external"`).
- `privateContext(options)`, both combined, and `strictest(...policies)`, which keeps the strictest answer.

Behavior and limits are documented in `docs/private-context-extension.md`.

## Validate

```sh
corepack pnpm --filter @eve/private-context typecheck
node --test "packages/eve-private-context/test/unit/*.test.ts"
corepack pnpm --filter eve exec vitest run --config vitest.integration.config.ts src/extensions/private-context
```
