# eve/extensions/taint

`eve/extensions/taint` records when a session reads untrusted content, so an agent-wide approval policy can ask a person before external effects and deny exports. It is a proof of concept for the derived-state proposal in [#5867](https://github.com/vercel/eve/pull/5867).

It ships inside the `eve` package. This private `@eve/taint` workspace package is its source of truth: eve's build copies `extension/` into `packages/eve/src/extensions/taint/extension` and publishes it as `eve/extensions/taint`.

## Mount

```ts
// agent/extensions/taint.ts
import taint from "eve/extensions/taint";

export default taint({});

// agent/agent.ts
import { defineAgent } from "eve";
import { taintPolicy } from "eve/extensions/taint";

export default defineAgent({ approval: taintPolicy() });
```

## Tags

eve doesn't interpret tags. The extension reads three:

| Tag               | Meaning                                                                        |
| ----------------- | ------------------------------------------------------------------------------ |
| `reads:untrusted` | The result can contain text someone outside the trust boundary wrote.          |
| `effect:external` | The call changes state or sends data outside the session.                      |
| `effect:export`   | The call moves data somewhere bulk or persistent: an export, upload, or share. |

Built-in tools have no tags, so `web_fetch`, `web_search`, `bash`, and `agent` count as `reads:untrusted` by name.

## What it contributes

- A hook (`extension/hooks/track.ts`) that keeps `taint.exposure` in `defineState`. `call.requested` with `reads:untrusted` adds the call to `pending`. `call.settled` removes it and, unless the call was rejected, marks the session exposed. `delivery.admitted` from anyone but the session's initiator marks it exposed with source `message` (config `untrustedMessages`, default `true`).
- `taintPolicy(options)`: once exposed, denies `effect:export` and asks before `effect:external`. Options: `exportTag`, `externalTag`, `onExport`, `untaggedConnections`, and `markOnRequest`.
- `taintRuntimeContext()` for `otelIntegration({ runtimeContext })`.

Behavior, subagents, timing, and limits are documented in `docs/taint-extension.md`.

## Validate

```sh
corepack pnpm --filter @eve/taint typecheck
node --test "packages/eve-taint/test/unit/*.test.ts"
corepack pnpm --filter eve exec vitest run --config vitest.integration.config.ts src/extensions/taint
```
