---
issue: "Draft PR discussion (link pending)"
status: proposed
last_updated: "2026-10-27"
---

# Session resource authorization

Route authentication identifies a caller but does not decide whether that caller may read or modify a particular session. Keep application ownership in application storage rather than introducing a tenant database into eve's execution core.

## Proposed API

```ts
export default eveChannel({
  auth: authenticateRequest,
  authorizeSession: ({ caller, request, sessionId }) => canAccessSession(caller, sessionId),
});
```

The verified transport caller, original request, and root/parent session ID are the complete input. The policy returns a boolean or promise; only `true` permits access. It must use a server-owned ownership or membership record, keyed by the verified issuer and identity. Creation remains route-authenticated; the application records ownership before returning the session ID, for example through a custom conversation-creation route.

## Observable behavior

- Every existing-session write, control, preparation, stub read, and stream checks the policy before session attachment or body parsing.
- Descendant and subagent stream routes authorize their root/parent session before resolving child bindings or credentials.
- Rejection returns a generic `403 session_access_denied`. A thrown policy error fails closed through normal channel error handling.
- Authentication runs once. `onMessage` remains a message transformation hook, not a resource-authorization substitute.
- Without a policy, `user` principals cannot access existing sessions. This is a breaking pre-1.0 correction. Non-user principals retain shared deployment access, including explicitly anonymous channels; tenant-scoped services must also install a policy.
- `authorizeSession: () => true` explicitly opts into shared access for authenticated users. The framework does not infer ownership from mutable turn auth, a session ID, or observability audience.

## Draft decision

Review the default policy and migration burden before making this ready. Blocking users without an application policy is intentional; automatically declaring a mutable current caller to be the owner would be incorrect for shared conversations and forwarded sessions. This proposal does not change callback capabilities, remote-agent principal forwarding, or the execution core.

## Validation

Owner-boundary route tests cover rejection before access across all session routes, default user rejection, and a server-owned permission check. CI eval coverage should exercise the configured policy through HTTP without contacting identity providers.
