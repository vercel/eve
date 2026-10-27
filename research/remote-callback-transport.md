---
issue: "https://github.com/vercel/eve/pull/5449"
status: proposed
last_updated: "2026-10-27"
---

# Remote callback transport credentials

A remote service needs the reply hook for its message, not the parent's deployment-wide protection secret. Remove automatic automation-bypass query parameters from framework callback URLs.

## Proposed operator configuration

On a Vercel remote deployment:

```sh
EVE_CALLBACK_TRUSTED_ORIGINS=https://parent.example.com,https://second-parent.example.com
```

The remote sends its own ambient Vercel OIDC token in the trusted-OIDC header only to its own deployment origins or these explicitly configured HTTPS origins. Match origins exactly, including ports. Reject entries with credentials, paths, queries, or fragments. A callback request cannot extend this server-owned allowlist.

On a protected parent, configure Vercel Trusted Sources to admit the remote project and environment. The callback's message-scoped hook remains the application-level capability. Public-destination checks, redirect rejection, timeout, and response-byte bounds remain enforced by the existing callback transport.

## Boundaries and migration

- Callback URLs never automatically include the automation bypass secret, regardless of whether that environment variable is present.
- Other external callback origins receive no ambient deployment credentials.
- Non-Vercel hosts do not attach Vercel credentials. Their hosting policy must make the capability-protected callback route reachable.
- Previously protected cross-project integrations need the reciprocal Trusted Sources rule and remote origin configuration before upgrade.
- Existing callbacks already persisted by an older driver are not rewritten or revoked by changing URL generation. Operators must separately assess rotation of previously shared bypass credentials.

This draft needs deployment validation for protected cross-project callbacks before readiness. Isolated tests cover URL payloads, explicit origin admission, unrelated-origin exclusion, and malformed configuration without contacting Vercel or a remote service.
