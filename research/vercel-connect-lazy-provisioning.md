---
issue: "TBD — existing tracking issue not identified"
status: proposed
last_updated: "2026-09-09"
---

# Vercel Connect lazy provisioning needs project-scoped connector resolution

## Summary

The eve registry currently authors connector references such as `connect("linear")`. These strings are exact, team-global connector UIDs, not service names or project-local aliases. Eager registry setup currently finds a compatible team connector, explicitly attaches it to the project using user authority, and patches the source with its actual UID.

Removing setup and enabling lazy provisioning does not preserve that behavior. A runtime requesting `uid: "linear"` can encounter an existing connector that is unavailable to its project/environment and receive `409 Conflict`.

The proposed solution is **durable project-scoped identifier resolution**, not automatic discovery and attachment of compatible team connectors:

```ts
auth: connect.project("linear", { autoProvision: true });
```

Connect would resolve `(teamId, projectId, "linear")` to a concrete connector. If the mapping has never been provisioned, it may create a new uniquely named connector and its initial attachments. It must not discover and attach an unrelated team connector, widen existing environment access, or undo an explicit detachment.

This deliberately results in fewer connectors being reused across projects, and potentially more connectors per team. In exchange, eligible eve registry connectors can omit eager setup and provision on first use without requiring a developer's user token in a deployed runtime. End-user OAuth consent is still required where applicable.

**Status:** The API shapes and structured errors below are proposals, not implemented functionality. This document supersedes the earlier proposal to preserve registry setup's team-wide canonical-name lookup and automatic attachment logic.

## Why not copy registry setup's resolution logic into the lazy provision logic?

The existing `setupConnectionConnector()` flow can:

1. Resolve the linked Vercel team and project.
2. Search team connectors by expected service and canonical display name/final UID segment.
3. Validate principal compatibility.
4. Attach an existing connector, or guide the user through selecting/creating another.
5. Patch `agent/connections/<slug>.ts` with the actual UID.
6. Clean up a newly created connector if setup fails.

That is an explicit setup workflow with user authority. A production-triggered registry install or runtime invocation may only have workload credentials. Automatically attaching a compatible team resource in that context creates cross-project access without an attributable user action.

The new default should not reproduce that search-and-attach behavior. Intentional reuse remains available through explicit user-authenticated setup. A project-local mapping to a shared connector must likewise be explicitly configured; attaching a connector alone does not establish its local alias in another project.

## Related PR: API #82852

[vercel/api#82852](https://github.com/vercel/api/pull/82852) centralizes managed connector naming in `resolveConnexCreateNames()`. It aligns connector names, UIDs, and provider app names around a common base, normalizes service aliases, and avoids repeated service suffixes.

It does **not** implement project-local aliases or change existing-connector attachment authority:

- The eve SDK sends an explicit `uid: "linear"`; that remains an exact team-global reference.
- Existing-UID lookup and attachment handling happen before new-connector naming.
- Explicit UIDs are not silently suffixed into different identities.
- Connector name uniqueness is checked separately from UID uniqueness. A fresh UID alone does not guarantee creation succeeds.
- The SDK currently discards the provisioning response and continues using the authored UID.

The PR is useful naming infrastructure, but naming allocation is not durable resolution or idempotency. Its stated scope does not establish that it was intended to fix this exact failure.

## Proposed authoring API

Keep exact references separate from project-scoped lookup:

```ts
connect("linear"); // Exact team-global UID; unchanged semantics
connect("scl_..."); // Exact connector ID

connect.project("linear"); // Project-scoped resolution only
connect.project("linear", { autoProvision: true }); // Provision if never configured
```

`autoProvision` defaults to `false`. Project-scoped identifiers are useful independently of provisioning: an administrator could configure the mapping through explicit setup.

An eligible registry definition becomes:

```ts
import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
  auth: connect.project("linear", { autoProvision: true }),
});
```

The runtime supplies the connection URL; authenticated OIDC supplies the team, project, and environment. For ordinary managed OAuth, Connect should derive and validate service identity through its existing URL normalization/discovery logic. Any required exceptional metadata belongs in an advanced option, not a mandatory provisioning block for every registry item.

`linear` is a stable connection slot, not a service search. A second independent connection can use `linear-support`. Registry updates and reinstalls must preserve the chosen key.

## Durable project-scoped resolution

The default mapping is:

```text
(teamId, projectId, connectionKey) -> connectorId
```

The environment controls access to the mapped connector, not its default identity. Different projects using `linear` get different mappings and independently provisioned connectors.

Connect must derive the scope from authenticated context. A caller-provided project ID or a bare team token without authorized project/environment context is insufficient.

Resolution/provisioning behavior:

1. **Mapping absent, auto-provision disabled:** return a structured setup-required error.
2. **Mapping absent, auto-provision enabled:** validate eligibility, reserve the key, allocate a unique UID and name, create the connector, and establish its initial authorized attachments.
3. **Mapping exists and current environment is attached:** return the same connector without mutation.
4. **Mapping exists but current environment is not attached:** return an actionable attachment-required error. Do not allocate a replacement or widen access.
5. **Connector detached, disabled, or deleted:** respect that administrative decision. Preserve sufficient mapping/tombstone state to prevent automatic replacement; reprovisioning requires explicit action.
6. **Configuration changed under the same key:** report a mismatch rather than silently repointing the alias. Validate normalized URL, service, managed OAuth configuration, and required principal compatibility on the backend.

Concurrent callers and retries must converge on one connector. Reserve the durable key before upstream OAuth registration and support recovery from partial creation/attachment failures. An SDK promise cache or randomly suffixed UID is not sufficient cross-worker coordination.

Return the concrete connector ID/UID for downstream operations. The local key must never be retried as a team-global UID.

## Environment scopes and promotion policy

### Default: one project-scoped connector with initial promotion

Preserve the current API's initial OIDC attachment policy:

| Environment that first provisions | Initial attachments                |
| --------------------------------- | ---------------------------------- |
| Development                       | Development, preview, production   |
| Preview                           | Preview, production                |
| Production                        | Production                         |
| Custom environment                | That exact custom environment only |

For example:

```ts
connect.project("linear", { autoProvision: true });
```

If development provisions first, production resolves the same connector and can use it. Production does not create another connector. The mapping survives cold starts, redeployments, and token rotation.

**Higher environments do not automatically grant lower environments access.** If production provisions first, a later preview or development invocation resolves the same connector but receives an attachment-required error. `autoProvision: true` does not authorize adding those attachments. Preview-first creation similarly does not grant development access.

An authorized user can explicitly attach the connector to the lower environment through supported dashboard/CLI setup. Once attached, the same source resolves successfully on retry, without redeployment or creating another connector.

The intentional tradeoff is first-use-order dependence in initial access. We preserve the existing authority boundary rather than permitting runtimes to incrementally widen attachments. Previously removed attachments must never be restored automatically.

### Optional isolated scope

A possible advanced option is:

```ts
connect.project("linear", {
  autoProvision: true,
  environmentScope: "isolated",
});
```

In this mode, identity includes the authenticated environment:

```text
(teamId, projectId, environmentId, connectionKey) -> connectorId
```

Development and production each provision their own connector, attached only to their own environment. Custom environments use stable environment IDs. Deployment IDs, branch names, token values, and machine identity must not enter the lookup key.

This avoids first-use-order dependence at the cost of more connectors and potentially separate OAuth consent per environment. It is not required for the initial project-scoped rollout. If added, scope modes must be distinguished durably, and changing modes must not silently migrate or repoint existing mappings. The final option name for the default promotion policy remains an API design decision.

## Actionable resolution and provisioning errors

Error handling is part of the implementation, not merely documentation around a raw 409. Missing mappings, inaccessible attachments, invalid configuration, and transient provisioning failures need distinct machine-readable reasons.

For example, project-scoped resolution could return:

```json
{
  "error": {
    "code": "connector_environment_not_attached",
    "environment": "preview",
    "setupUrl": "<authorized connector attachment settings URL>"
  }
}
```

This is distinct from `connector_not_configured`, `connector_disabled`, `connector_configuration_mismatch`, and transient `connector_provisioning_failed` results. Exact names/envelopes are proposed. Responses must not disclose inaccessible team resources or credentials.

### Connect SDK and eve adapter

In `@vercel/connect/eve`:

- Resolve the project-scoped identity before token/authorization operations.
- Translate structured failures into typed errors, including resolution/provisioning phases for the existing `onError` customization hook.
- Represent missing environment access as an operator setup requirement, **not** an ordinary end-user OAuth consent challenge.
- Preserve enough safe context for eve to display remediation in connection status/setup UI and on the failed operation.
- Do not interpret arbitrary 403/409 responses as permission to create a replacement or change scope.
- Retry only appropriate transient failures using the same durable provisioning key; do not send operators to attachment setup for unrelated network/provider errors.

For an authorized developer/operator, show guidance such as:

> Linear is configured for this project but is not attached to Preview. An authorized project administrator must attach the existing connector to Preview in Vercel Connect, then retry. No source change or redeployment is required.
>
> Configure connector ->

Provide the actual settings URL and, once verified against the supported CLI, an exact attachment command. Do not send the user through Find/Create or suggest a new UID when the mapped connector only needs an attachment. If the current setup command cannot target the mapped connector/environment, extend it or direct users to supported dashboard functionality.

For an ordinary agent user, say that administrator setup is required without exposing internal connector IDs, team details, or privileged settings information. Follow existing eve error rendering and redaction conventions.

Manual remediation must be explicitly user-authenticated and audited. Do not fabricate user attribution from an agent's end-user principal or substitute a team/workload token for user authority.

After attachment, retry should work without redeployment. Do not durably cache attachment failures. Cached successful identity resolution must not bypass server-side access checks or authorize a detached connector.

## Implementation changes

### Connect backend

- Add project-scoped lookup/provisioning and durable mappings, with atomic reservation and recoverable creation state.
- Preserve exact UID/ID semantics and the default initial environment-promotion policy.
- Use centralized naming helpers, ensuring both generated names and UIDs are unique.
- Return resolved connector identity and structured setup/provisioning errors.
- Preserve administrative detach/disable/delete decisions and audit workload creation honestly.
- Support explicit user-attributed mapping/attachment configuration for intentional sharing and remediation.

### `@vercel/connect`

- Add `connect.project(key, options)` with resolution independent of `autoProvision`.
- Replace the provisioning helper's `Promise<void>` assumption with resolved identity handling.
- Use the concrete identity consistently for token retrieval, authorization start/completion, revocation, cache eviction, and connector metadata.
- Ensure operations without connection context can resolve an existing mapping without creating resources; fail clearly if required authenticated context is unavailable.
- Bound caches and partition them by authenticated scope, endpoint, key, and configuration. Caching must not become an access-control decision.
- Add typed errors, resolution/provisioning error phases, and actionable eve setup translation.
- Correct documentation claiming runtime provisioning can generally link existing team connectors.

The resolved-identity plumbing, bounded cache, and structured error work in `prha/connect-lazy-provisioning` may be reusable. Its canonical-name/team-search contract should be replaced, not carried forward.

### eve registry

- Emit `connect.project("<key>", { autoProvision: true })` for eligible managed user-OAuth items.
- Remove their eager setup steps only after the backend and SDK contract is available.
- Preserve stable keys on updates/reinstalls and leave explicitly configured exact references unchanged.
- Keep an optional user-authenticated setup flow for intentional existing-connector reuse and environment remediation.
- Retain setup for providers requiring app installation, JWT-bearer configuration, API keys, or custom creation.

The earlier inventory identified 38 candidate standard user-managed OAuth items:

```text
airtable, bitly, brex, candid, clickhouse, cloudinary, coda,
context, egnyte, embat, hugging-face, linear, local-falcon,
make, manufact, mem0, miro, mixpanel, natural, netlify,
notion, oreilly, planetscale, posthog, postman, razorpay,
sentry, similarweb, stripe, supabase, ticket-tailor, ticktick,
todoist, vercel, webflow, wix, zapier, zomato
```

Revalidate eligibility from registry auth/setup properties before rollout rather than treating this inventory as permanent. Context (`mcp.context.dev`) is a useful test of backend service resolution rather than guessing service identity from the local key.

Retain explicit setup for AgentCard (custom creation), Neon and Tinybird (app-scoped installations), and Datadog and Honeycomb (JWT-bearer subjects). Browser Use is API-key based and Shopify has separate custom setup. Do not remove setup merely because an item uses Connect somewhere in its definition.

## Acceptance tests and rollout

Before removing eligible registry setup steps, cover:

1. Two projects in one team using `linear` provision different connectors; any existing generic `linear` connector is untouched.
2. Repeated calls, concurrent cold starts, redeployments, and token rotations resolve the same project mapping.
3. Development-first creation allows preview/production reuse without further provisioning.
4. Production-first creation produces a clear attachment-required error in preview/development; explicit user attachment followed by retry succeeds without redeployment.
5. Preview-first creation does not grant development access; custom environments remain exact-only.
6. Detachment, disablement, deletion, and removed environment permissions are not undone by `autoProvision`.
7. Both name and UID collisions, upstream registration failures, and partial attachment failures recover without duplicate logical connectors.
8. Configuration/principal mismatches produce explicit setup guidance, not unsafe reuse.
9. `autoProvision: false` resolves existing mappings but never creates one.
10. Exact UID/ID references and explicit user-attributed sharing retain their semantics.
11. Error rendering gives developers actionable remediation while redacting internal details from ordinary agent users.
12. If isolated scope ships, different environments receive different connectors and changing scope cannot silently repoint an existing mapping.

Use real API contract/integration coverage for cross-project and environment behavior; SDK mocks alone cannot validate attachment authority. Roll out backend resolution and structured errors first, then SDK/eve handling, then eligible registry definitions and setup removal.

The success criterion is not zero 409s at any cost. It is safe, durable project-local resolution that enables lazy provisioning for ordinary registry installs, preserves deliberate access restrictions, and gives operators a clear recovery path when explicit attachment is required.
