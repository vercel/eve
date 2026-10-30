---
issue: "https://github.com/vercel/eve/pull/5449"
status: implemented
last_updated: "2026-10-28"
---

# Remote callback transport credentials

A remote service needs the reply hook for its message, not the parent's deployment-wide protection secret. Remove automatic automation-bypass query parameters from framework callback URLs.

## Operator configuration

On a Vercel remote deployment:

```sh
EVE_CALLBACK_TRUSTED_ORIGINS=https://parent.example.com,https://second-parent.example.com
```

The remote sends its own ambient Vercel OIDC token in the trusted-OIDC header only to its own deployment origins or these explicitly configured HTTPS origins. Match origins exactly, including ports. A leading `*.` label (for example `https://*.preview.example.com`) matches exactly one subdomain label at the same port, needs at least two labels after it, cannot end in a trailing dot, and cannot cover `vercel.app`. That denylist is best-effort; other shared domains are not detected. Reject entries with credentials, paths, queries, or fragments. A callback request cannot extend this server-owned allowlist.

Adding an origin is a trust grant. The ambient OIDC token is a bearer credential for the remote project's identity, not a recipient-scoped callback token. A listed parent can replay it against any other service, Trusted Sources rule, or federated role accepting that identity until expiry. Only explicitly trusted parents belong in this list.

On a protected parent, configure Vercel Trusted Sources to admit the remote project and environment. The callback's message-scoped hook remains the application-level capability. Public-destination checks, redirect rejection, timeout, and response-byte bounds remain enforced by the existing callback transport.

## Boundaries and migration

- Callback URLs never automatically include the automation bypass secret, regardless of whether that environment variable is present.
- Other external callback origins receive no ambient deployment credentials.
- Non-Vercel hosts do not attach Vercel credentials. Their hosting policy must make the capability-protected callback route reachable.
- Previously protected cross-project integrations need the reciprocal Trusted Sources rule and remote origin configuration before upgrade.
- Existing callbacks already persisted by an older driver are not rewritten or revoked by changing URL generation. Operators must separately assess rotation of previously shared bypass credentials.

Isolated tests cover URL payloads, explicit origin admission, unrelated-origin exclusion, and malformed configuration. This change was not tested against real protected cross-project deployments. Operators must verify their Trusted Sources and exact-origin configuration when rolling out the documented migration.
