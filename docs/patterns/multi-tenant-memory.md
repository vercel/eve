---
title: "Multi-Tenant Memory"
description: "Bind an eve memory provider to an authenticated tenant and caller scope."
---

A memory slot's `scope` decides who shares its memory. For multi-tenant memory,
return a scope built from the signed-in tenant and user. eve passes the
resulting key to every [memory provider](../memory) call, so each tenant and
user gets separate memory.

The example below uses the built-in `fileMemory()` provider. You can use
Supermemory or a custom provider with the same `scope`. The memory definition
determines the tenant-specific key passed to the provider.

## Derive scope from authenticated context

Never accept the tenant or user ID from the model. Read both from verified
session authentication and return a tuple:

```ts title="agent/memory/profile.ts"
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { fileMemory } from "eve/memory/file";

export default defineMemory({
  description: "Remember information about the authenticated tenant user across sessions.",
  provider: fileMemory(),

  scope(ctx) {
    const caller = ctx.session.auth.current;
    const tenantId = caller?.attributes.tenantId;
    const principal = byPrincipal(ctx);

    // no memory for non-users, callers without a tenant, or anonymous callers
    if (caller?.principalType !== "user" || typeof tenantId !== "string" || principal === null) {
      return null;
    }

    // one memory per user within each tenant
    return [tenantId, principal];
  },
});
```

Returning `null` turns memory off for anonymous or incorrectly scoped callers.
eve does not call the provider and never substitutes a shared scope.

`byPrincipal(ctx)` combines the caller's `principalType`, `authenticator`,
`issuer`, and `principalId`. This keeps two callers apart even when the same
user ID exists in two sign-in systems.

Use `auth.current` for the caller of the active turn. If only the person who
started a conversation may use it, use `auth.initiator` and enforce that rule
at the channel boundary.

## Restrict provider access by memory key

eve derives an opaque `memory.scope.key` from the namespace and scope tuple.
The provider receives that key in every recall, capture, and tools call.

eve fixes the key for provider tools, preventing the model from selecting
another tenant or caller. Use `memory.scope.key` in every provider read and
write.

For semantic retrieval, filter by the key in the database or service query
itself, not after a global search. For custom capture, use the provider's
stable `operationId` as an idempotency key. See
[Build a memory provider](../memory/custom-provider) for the full contract.

## When the caller changes

eve recalls again when the signed-in caller changes within one session. With
the scope above, a new caller gets a new scope, and the slot starts empty.
Memory recalled for the earlier caller leaves the model's context. eve can't
remove what an earlier assistant response already said. Give participants who
must not see each other's memory separate sessions.

## Set the trust policy

Recalled values become user-role messages. Tell the agent to treat memories as
untrusted information, not instructions, and tell it what it may save. See
[Tell the model how to use memory](../memory#tell-the-model-how-to-use-memory)
for an instructions snippet. A custom provider can also set `approval` on its
tools when your product requires confirmation before saving or deleting memory.

Do not use `defineState` for data that must outlive a session. State belongs
to one session. Memory providers share data across sessions through their own
storage.
