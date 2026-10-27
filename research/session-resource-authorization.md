---
issue: "https://github.com/vercel/eve/pull/5451"
status: implemented
last_updated: "2026-10-27"
---

# Session resource authorization

Authentication identifies a caller but does not authorize a particular session. Default user access follows immutable HTTP creator ownership. An explicit `authorizeSession` hook replaces that default when an application needs its own ownership store or intentionally shared conversations.

## API

```ts
export default eveChannel({
  auth: authenticateRequest,
  authorizeSession: ({ caller, request, sessionId }) => canAccessSession(caller, sessionId),
});
```

The verified transport caller, original request, and root/parent session ID are the complete policy input. Only `true` allows access; rejection returns generic `403 session_access_denied`, and exceptions fail closed through normal channel handling.

## Default ownership

The initial run attributes contain a versioned hash of the creator's principal type, tagged issuer/authenticator authority, and principal ID. The existing `audienceAuth` input carries the verified HTTP transport identity independently of mutable runtime auth. Seeding this attribute alongside the run's creation makes ownership available before returning its ID, including bodyless creation. Idempotent creates reuse the original run's attribute; later turns never replace it.

Existing-session requests read only run metadata (`resolveData: "none"`) and compare the verified user before session attachment, body parsing, commands, or stream reads. This state does not depend on mutable turn auth, first-message initialization, trace capture, workflow-input retention, or side-stream survival after external cancellation. There is no new database, runtime dependency, or server secret. The only execution-core change seeds the owner hash in initial run attributes; policy evaluation stays at the HTTP boundary.

Non-user principals retain deployment-wide shared transport access. Tenant-scoped service principals should install an explicit policy. Callback capability semantics and forwarded principal projection are unchanged; the default owner is the verified HTTP transport caller, not a client-asserted body identity.

## Migration

Same-user linked-development/TUI, Basic auth, Auth.js, Better Auth, and first-party chat flows remain usable without a blanket shared-access grant. Authentication and per-user outbound connection identity remain unchanged.

Sessions without a recorded HTTP owner, including sessions created by another channel or a previous release, are denied to user callers by default. There is no inference from current turn auth and no fail-open legacy fallback. Applications must provide a server-owned policy to grant access to those sessions, or create a new HTTP session. An explicit policy replaces the default owner check and owns its own permission lifecycle.

Descendant and subagent routes authorize the requested parent/root session before resolving child bindings. Synthetic descendant-reader histories deliberately grant their authenticated fixture operator shared access; they do not weaken production templates.

## Validation

Owner-boundary unit tests exercise issuer separation, unknown owners, backing-store failures, and default route delegation. A real Workflow integration test verifies transport identity wins over projected runtime identity and remains authorized after external cancellation. Focused integration tests also exercise descendant proxies and the default client/TUI flow. A fixture-owned HTTP eval exercises user creation, permitted stream/send, and another issuer's denied read/reset through the real deployed API. Full integration, scenario, web-chat, and world suites remain CI's official validation boundary.
