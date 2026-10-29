---
issue: "Maintainer-approved pre-1.0 auth boundary cleanup; related #5479"
status: implemented
last_updated: 2026-10-29
---

# eve-channel auth permissions

Keep shared authentication results identity-only. Tool replacement is an eve-channel permission, not a verifier feature or durable session identity.

## Authoring API

- `AuthResult` from `eve/channels/auth` contains only identity fields.
- `AuthFn<TEvent = Request, TResult extends AuthResult = AuthResult>` supports channel-specific result types while keeping identity-only defaults.
- `EveAuthResult` from `eve/channels/eve` extends `AuthResult` with `allowToolStubs?: boolean`.
- `EveAuthFn` from `eve/channels/eve` is `AuthFn<Request, EveAuthResult>`. Use it for named callbacks returning the grant; identity-only callbacks remain valid.
- `vercelOidc({ subjects })` from `eve/channels/auth` accepts `readonly string[]` only. Subject matches authenticate callers but never grant tool replacement.
- `eveVercelOidc(options?: EveVercelOidcOptions)` from `eve/channels/eve` returns an `EveAuthFn`. Its options match `VercelOidcOptions` except `subjects` accepts `readonly (string | { readonly subject: string; readonly allowToolStubs?: boolean })[]`.

Use `eveVercelOidc` for declarative OIDC grants. It delegates authentication to the shared verifier and automatically declares Bearer challenges. After verification, any matching subject pattern with `allowToolStubs === true` grants permission only to `service` or `runtime` principals. User principals never receive this helper's grant. Plain strings, non-granting matches, and implicit current-project acceptance alone do not grant permission; a non-granting match does not revoke an explicit granting match. Subject patterns retain the shared AWS IAM-style `*` semantics. Build them with `vercelSubject`, whose default environment is production.

Custom eve-channel authenticators can still return the flag directly after verifying their caller. They own the permission policy; the shared verifier does not.

## Observable semantics

The ordered auth walk stops at its first successful result. Permissions are not merged across authenticators. Replace a grant-bearing `vercelOidc` entry with `eveVercelOidc` rather than placing the new helper after an identity-only entry that already accepts the caller.

Stubbed session creation and stub verification require `allowToolStubs === true` on the current request's eve auth result. The channel checks the grant before forwarded-principal handling or `onMessage` identity projection. It removes the grant before identity persistence, forwarding, or audience classification. Request JSON, forwarded identity, and session attributes cannot supply it.

Later messages, approvals, controls, and result reads retain ordinary channel authentication without a creator-only or tool-replacement recheck. Applications remain responsible for session-access isolation: a caller admitted to an existing stubbed session can use its configured stubs.

## Migration and scope

Rename grant-bearing `vercelOidc` calls to `eveVercelOidc` and move the import to `eve/channels/eve`, preserving the subject declarations. Use `EveVercelOidcOptions` for named options. Change grant-bearing custom `AuthFn` / `AuthResult` annotations to `EveAuthFn` / `EveAuthResult`. See the [migration guide](../docs/guides/prepare-for-1-0.md#move-tool-replacement-grants-to-eve-channel-auth) and [canonical auth example](../docs/guides/auth-and-route-protection.md#tool-replacement-permission).

This cleanup does not change agent-info route configurability or introduce another permission. It preserves existing custom-auth grants and request-local gate semantics.
