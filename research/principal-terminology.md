---
issue: https://github.com/vercel/eve/issues/3362
status: proposed
last_updated: "2026-09-15"
---

# Connection credential and audience terminology

## Summary

This patch adds clearer authoring terminology without removing existing APIs. Raw non-interactive connection auth can use `credentialOwner: "app" | "user"` in place of the ambiguous `principalType`; the old field remains supported and deprecated for connection-auth authoring only. Channel audience callbacks gain a minimal `caller` projection while retaining the existing `auth` input.

Related to #3362. This patch intentionally preserves the current default audience classification: anonymous callers remain public; user, service, and runtime callers remain private; local-dev, unknown, and custom kinds remain unknown.

## Boundaries

- `SessionAuthContext.principalType` continues to describe caller identity and is not deprecated.
- Runtime `AuthorizationDefinition`, durable conversation context fields, and cross-version wire schemas remain unchanged.
- `@vercel/connect/eve` continues to use its `principalType` option because it is Vercel Connect terminology.
- The token cache remains step-local, so changing its in-memory principal-key encoding requires no migration.

## Behavior

`credentialOwner` and legacy connection-level `principalType` normalize into the existing runtime `principalType` representation. A definition cannot supply both fields, even with matching values. The default remains app credentials when neither is provided.

`caller` exposes an anonymous discriminator or a principal's kind, authenticator, and attributes. It omits principal IDs, issuers, and subjects because audience classification does not need them. Existing `audience({ auth })` callbacks remain valid while authors migrate to `caller`.
