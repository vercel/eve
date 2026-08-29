---
issue: https://github.com/vercel/eve/issues/1711
status: implemented
last_updated: "2026-08-29"
---

# Dynamic connections

## Decision

Allow a module under `connections/` to export `defineDynamic({ events })` from
`eve/connections`. Session and turn handlers return one
`defineMcpClientConnection(...)` or `defineOpenAPIConnection(...)`, a map of
connection definitions, or `null`.

```ts
// agent/connections/accounts.ts
import { defineDynamic, defineMcpClientConnection } from "eve/connections";

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) =>
      Object.fromEntries(
        (await listAccounts(ctx.session.auth.current)).map((account) => [
          account.slug,
          defineMcpClientConnection({
            description: account.description,
            url: account.mcpUrl,
          }),
        ]),
      ),
  },
});
```

A single result uses the file's path-derived name. Map keys are bare connection
names and must satisfy the existing connection-name grammar. Extension map
results receive the mount namespace. A turn result shadows the same resolver's
session result, including `null`.

Dynamic connections override same-named static connections. Two effective
dynamic resolvers emitting the same name fail as ambiguous. Invalid or throwing
resolvers fail closed and contribute no connections.

## Runtime boundary

The compiler classifies the module and retains its event handlers as runtime
entries. Resolved definitions enter the existing per-step connection registry,
so `connection_search`, qualified connection tools, auth, approval, filters,
headers, and provided arguments use the ordinary connection pipeline.

Connection definitions contain live callbacks that cannot enter durable
workflow state. When an active turn resumes in a new durable step, eve reruns
its effective session and turn resolvers before authorization or tool execution.
Resolvers must therefore be idempotent. The durable state continues to store no
connection credentials or live functions.

```text
session/turn event ─> dynamic resolver ─> resolved connection set
                                              │
durable resume ─────> rerun active resolvers ─┤
                                              v
                                  per-step connection registry
                                              │
                          connection_search + qualified tools
```

Dynamic connections do not support `step.started`. Changing the connection set
between individual model calls would make discovered tool identity and parked
authorization unstable within a turn.
