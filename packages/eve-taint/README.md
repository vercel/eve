# eve/extensions/taint

`eve/extensions/taint` applies Meta's Rule of Two. It records when a session reads untrusted content and when it reads sensitive data, so an agent-wide approval policy can ask a person before an external effect only when all three meet, and deny exports then. It is a proof of concept for the derived-state proposal in [#5867](https://github.com/vercel/eve/pull/5867).

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

eve doesn't interpret tags. The extension reads these:

| Tag                | Leg       | Meaning                                                                        |
| ------------------ | --------- | ------------------------------------------------------------------------------ |
| `reads:untrusted`  | untrusted | The result can contain text someone outside the trust boundary wrote.          |
| `reads:sensitive`  | sensitive | The result can contain private or sensitive data.                              |
| `reads:personal`   | sensitive | The result can contain the caller's private data.                              |
| `effect:sensitive` | sensitive | The call acts on a sensitive system, such as production or billing.            |
| `effect:external`  | effect    | The call changes state or sends data outside the session.                      |
| `effect:export`    | effect    | The call moves data somewhere bulk or persistent: an export, upload, or share. |

Built-in tools have no tags, so `web_fetch`, `web_search`, and `bash` count as `reads:untrusted` by name, and `agent` as both `reads:untrusted` and `reads:sensitive`.

## What it contributes

- A hook (`extension/hooks/track.ts`) that keeps `taint.exposure` in `defineState`. `call.requested` for a read tag adds the call to `pending` with its legs. `call.settled` removes it and, unless the call was rejected, records its legs and source. `delivery.admitted` from anyone but the session's initiator records the untrusted leg with source `message` (config `untrustedMessages`, default `true`).
- `taintPolicy(options)`: once the session has the untrusted leg, and the sensitive leg or a call tagged `effect:sensitive`, denies `effect:export` and asks before `effect:external`. Options: `exportTag`, `externalTag`, `onExport`, `untaggedConnections`, `assumeSensitive`, and `markOnRequest`.
- `taintRuntimeContext()` for `otelIntegration({ runtimeContext })`.

Behavior, subagents, timing, and limits are documented in `docs/taint-extension.md`.

## Validate

```sh
corepack pnpm --filter @eve/taint typecheck
node --test "packages/eve-taint/test/unit/*.test.ts"
corepack pnpm --filter eve exec vitest run --config vitest.integration.config.ts src/extensions/taint
```
