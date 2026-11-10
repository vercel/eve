---
issue: https://github.com/vercel/eve/issues/1130
status: proposed
last_updated: "2026-11-10"
---

# Session route authorization

## Problem

Applications need a shared authorization policy for session reads and controls, as requested in #1130. `onMessage` covers message delivery only. The policy should receive the matched session ID and support conversations before their first turn.

## Authoring API

```ts
export default eveChannel({
  auth,
  async authorizeSession({ caller, sessionId, getCreator }) {
    if (await mayManageSession(caller, sessionId)) return true;
    const creator = await getCreator();
    return (
      creator != null &&
      caller.issuer === creator.issuer &&
      caller.principalId === creator.principalId
    );
  },
});
```

The optional hook receives the authenticated transport caller, the matched session ID, and `getCreator()`. Only `true` admits the operation. Denial or an exception returns a generic 403 before session access. Omitting the hook preserves existing behavior.

## Runtime boundary

Run the hook after authentication and route-parameter validation, before follow-up, preparation, controls, stub inspection, or streaming. Descendant and remote-child reads authorize the parent session; existing child-binding validation remains mandatory. Creation remains governed by route authentication.

Record the effective creation identity in a private stream on the original session run before returning its ID. Trusted forwarded identity is preserved. Later callers and deployment handoffs cannot replace the creator. This record survives workflow-input retention and never enters the public event stream. The lazy lookup avoids storage reads for policies that do not need ownership.

`getCreator()` returns `null` for anonymous creation and `undefined` for sessions without a creator record. Applications must choose an explicit policy for older sessions; absence never implies ownership. The execution-time `session.auth.initiator` contract is unchanged.

## Validation

Cover authorized and unauthorized users through actual route handlers, including router parameters, message-free creation, controls, and parent-scoped streams. Verify creator persistence before acceptance, anonymous and missing records, forwarding, and unchanged behavior without the hook. No new database, URL parser, or HTTP ownership endpoint.
