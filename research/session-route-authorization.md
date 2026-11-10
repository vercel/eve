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

Record the transport identity that created the session as `$eve.creator.*` attributes on the run it starts. `start()` writes attributes with the run, so a concurrent or retried creation that is answered with an existing session ID names a session whose creator is already readable, and a failed start records nothing. Later callers, accepted forwarded initiators, and deployment handoffs cannot replace the creator. The record holds identity fields only, never request-local grants, and never enters the public event stream. The lazy lookup avoids a run read for policies that do not need ownership.

This is the per-session complement of channel admission such as `auth` here and `allowFrom` on the Slack channel (#5816): admission decides whether the caller may reach the agent at all; `authorizeSession` decides whether they may touch one session.

`getCreator()` returns `null` for anonymous creation and `undefined` for sessions without a creator record. Applications must choose an explicit policy for older sessions; absence never implies ownership. The execution-time `session.auth.initiator` contract is unchanged.

## Validation

Cover authorized and unauthorized users through actual route handlers, including router parameters, message-free creation, controls, and parent-scoped streams. Verify the creator is recorded with the start, is readable to a concurrent creation that joins the owner, maps anonymous callers to `null`, stays the transport identity under an accepted forwarded principal, and that behavior without the hook is unchanged. No new database, URL parser, or HTTP ownership endpoint.
