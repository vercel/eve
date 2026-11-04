# eve/extensions/untrusted-content

`eve/extensions/untrusted-content` records when a session reads untrusted content, so an agent-wide approval policy can ask a person before external and irreversible calls, and deny publishing. It is a proof of concept for the derived-state proposal in [#5867](https://github.com/vercel/eve/pull/5867).

It ships inside the `eve` package. This private `@eve/untrusted-content` workspace package is its source of truth: eve's build copies `extension/` into `packages/eve/src/extensions/untrusted-content/extension` and publishes it as `eve/extensions/untrusted-content`.

## Mount

```ts
// agent/extensions/untrusted-content.ts
import untrustedContent from "eve/extensions/untrusted-content";

export default untrustedContent({});

// agent/agent.ts
import { defineAgent } from "eve";
import { untrustedContentPolicy } from "eve/extensions/untrusted-content";

export default defineAgent({ approval: untrustedContentPolicy() });
```

## Tags

eve doesn't interpret tags. The extension reads four, named to line up with MCP's tool hints and draft annotations:

| Tag                   | Meaning                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `reads:untrusted`     | The result can contain text someone outside the trust boundary wrote. |
| `effect:external`     | The call changes state or sends data outside the session.             |
| `effect:irreversible` | The call can't be undone. It counts as external too.                  |
| `sink:public`         | The call can put data somewhere publicly accessible.                  |

Built-in tools have no tags, so `web_fetch`, `web_search`, `bash`, and `agent` count as `reads:untrusted` by name.

## What it contributes

- A hook (`extension/hooks/track.ts`) that keeps `untrusted-content.exposure` in `defineState`. `call.requested` with `reads:untrusted` adds the call to `pending`. `call.settled` removes it and, unless the call was rejected, marks the session exposed. `delivery.admitted` from anyone but the session's initiator marks it exposed with source `message` (config `untrustedMessages`, default `true`).
- `untrustedContentPolicy(options)`: once exposed, asks before `effect:external` and `effect:irreversible`, and denies calls that are both irreversible and `sink:public`. Options: `onPublish`, `untaggedConnections`, `markOnRequest`, and `when`, which narrows external calls to the ones a confidentiality check matches (the Rule of Two). Irreversible calls ask either way.
- `untrustedContentRuntimeContext()` for `otelIntegration({ runtimeContext })`.

Behavior, subagents, timing, and limits are documented in `docs/untrusted-content-extension.md`.

## Validate

```sh
corepack pnpm --filter @eve/untrusted-content typecheck
node --test "packages/eve-untrusted-content/test/unit/*.test.ts"
corepack pnpm --filter eve exec vitest run --config vitest.integration.config.ts src/extensions/untrusted-content
```
