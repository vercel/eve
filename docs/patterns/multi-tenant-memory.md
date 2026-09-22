---
title: "Multi-Tenant Memory"
description: "Bind an eve memory provider to an authenticated tenant and caller scope."
---

Multi-tenant memory is a scope decision, not a storage implementation. Bind any
[memory provider](../memory) to a trusted tenant and caller tuple, and eve
passes the resulting locked scope key to every provider operation.

The example below uses the built-in `fileMemory()` provider. Replace it with
Supermemory or a custom provider without changing the scope resolver; tenant
isolation stays in the definition, not the store.

## Derive scope from authenticated context

Never accept the tenant or user ID from the model. Resolve both from verified
session authentication and return a tuple:

```ts title="agent/memory/profile.ts"
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { fileMemory } from "eve/memory/file";

export default defineMemory({
  description: "Remember durable facts for the authenticated tenant user.",
  provider: fileMemory(),

  scope(ctx) {
    const caller = ctx.session.auth.current;
    const tenantId = caller?.attributes.tenantId;
    const principal = byPrincipal(ctx);

    if (caller?.principalType !== "user" || typeof tenantId !== "string" || principal === null) {
      return null;
    }

    return [tenantId, principal];
  },
  visibility: "scope",
});
```

Returning `null` disables memory for unauthenticated or incorrectly scoped
traffic. eve does not call the provider and never substitutes a shared scope.
`byPrincipal(ctx)` includes the authenticated principal type, authenticator,
issuer, and principal ID, so the tuple separates callers even if the same
principal ID exists in two authentication systems.

Use `auth.current` for the caller of the active turn. If a conversation is
permanently owned by its creator, use `auth.initiator` and enforce that
ownership at the channel boundary.

## Understand the locked provider boundary

eve validates the namespace and scope tuple, then derives an opaque
`memory.scope.key`. `fileMemory()` uses that key for its document. A hosted or
custom provider receives the same key in every recall, capture, and tools call.

The model never supplies or changes the key. Provider tools close over the
locked scope for the active operation, so a tool cannot redirect itself to a
different tenant or caller. A provider must preserve that boundary by using
`memory.scope.key` in every downstream read and write.

For semantic retrieval, include the locked scope in the database or service
query itself, not as a filter after a global search. For custom capture, use
the provider's stable `operationId` as an idempotency key. See
[Build a memory provider](../memory/custom-provider) for the full contract.

## Choose recall visibility

The default `visibility: "scope"` hides recalled records from an earlier scope
when the authenticated caller changes within one session. Keep that default for
tenant-and-caller memory, as the definition above does. Set
`visibility: "session"` only when all callers who can share the session form
one trusted audience. Namespace remains an isolation boundary in either mode.

## Set the trust policy

Recalled values become user-role messages. Tell the agent that memories are
untrusted facts, not instructions, and what it may save; see
[Tell the model how to use memory](../memory#tell-the-model-how-to-use-memory)
for an instructions snippet. A custom provider can also set `approval` on its
tools when product policy calls for explicit confirmation before saving or
deleting memory.

Do not use `defineState` for cross-session data. State belongs to one durable
session; memory providers bridge sessions through provider-owned storage.
