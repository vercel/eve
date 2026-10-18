---
issue: "TBD (maintainer-requested research; no matching issue found)"
status: proposed
last_updated: "2026-10-16"
---

# Lazy Vercel Connect provisioning with project-local UIDs

## Decision

Keep registry-authored connections unchanged:

```ts
import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
  auth: connect("linear"),
});
```

For eligible managed OAuth connections, `"linear"` will be treated as a **project UID**: a name local to the deploying project, not a team-wide connector identifier. On first use, Connect will resolve the connector this project already maps to that name, or provision a new one for the project, and the adapter will use the returned connector ID for every token and authorization operation. No new eve authoring API is needed. The work spans the Connect API, `@vercel/connect/eve`, and a registry rollout.

Today, the `connex-project-uid` team flag lets users map a project UID onto a connector's project attachment, and project-scoped reads resolve that mapping first. Deployments cannot use it to provision: the managed OAuth endpoint rejects `projectUid` from deployment OIDC tokens, and a bare key that has no project mapping falls back to a team-wide connector UID. The adapter sends the authored string as that team-wide UID.

## Contract

The adapter will send the authored key as `projectUid` to Connect's managed OAuth creation endpoint, authenticated by the deployment's OIDC token. The project and environment come from that token, never from the request body. Only URL-backed managed OAuth connections use this path. Opaque connector IDs (`scl_...`), app or JWT-bearer setups, provider-specific setups, triggers, and connections without a provisionable URL keep their existing behavior; combining `projectUid` with those options is a `400`.

Resolution for a `(project, environment, key)` request is scoped to connectors already attached to the requesting project. It never selects a connector merely because it exists elsewhere in the team, and no OIDC request attaches a connector to another project or widens its environments.

| State in the requesting project                                                                                                             | Result                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A connector is mapped to `key` and attached to this environment                                                                             | Use it, after checking compatibility.                                                                                                                         |
| A compatible connector whose team UID is exactly `key` is attached to this environment                                                      | Use it unchanged. This keeps source patched by today's `eve integration connect` working.                                                                     |
| A connector mapped to `key`, or whose team UID is exactly `key`, is attached to this project but not this environment                       | `attachment_required`.                                                                                                                                        |
| A connector Connect provisioned or auto-linked for `key` was removed or remapped by a user                                                  | `attachment_removed` or `project_uid_removed`, with its `connectorId`. See [Removal and recovery](#removal-and-recovery).                                     |
| A compatible connector named `key` (display name or final UID segment) is attached in any environment, with no project UID                  | `mapping_required` with its `connectorId`, or `ambiguous` when several match. Connect writes nothing; a user maps it to `key` or removes it from the project. |
| Several connectors are mapped to `key`, a name match has another project UID, or the connector `key` resolves to has a weaker configuration | `ambiguous`, `alias_conflict`, or `configuration_mismatch`. Connect never picks one arbitrarily or repoints the key.                                          |
| None of the above                                                                                                                           | Provision a new connector for this project with a unique team-wide name, map it to `key`, and attach it to the allowed environments.                          |

A connector is **compatible** when it is an OAuth connector for the same server (same host and path, ignoring a leading `www.` and a trailing `/sse` or `/mcp`) and has at least the requested grants (user authorization, client credentials, refresh tokens), secure egress network, and forwarded claims. A request never resolves to a connector with weaker settings than it asks for. An unrelated team connector whose UID happens to be `linear` but is not attached to this project is ignored and does not block provisioning.

New connectors take their display name, OAuth client name (shown on the provider's consent screen), and team UID from the connection's `name` when set, and from the project name otherwise.

### Removal and recovery

Connect never maps a connector it did not create. The only connectors a deployment attaches or maps on its own are ones Connect provisioned for the key, or an exact team-UID match it auto-linked on an OIDC request. For those, a user's removal is final: removing the connector from the project, or clearing or changing its project UID, makes the next request report `attachment_removed` or `project_uid_removed` with the connector's ID instead of provisioning a replacement. Otherwise the dashboard could not stop a deployment from using a connection, and every cycle would orphan a connector and its OAuth client and force fresh consent. Recovery:

1. Reconnect the same connector to the project with the project UID; its grants are kept.
2. Map a different connector to the project UID.
3. Delete the connector; the next request provisions a fresh one that needs new consent.

A connector a user mapped to the key is the user's to manage. Clearing its project UID while it stays attached reports `mapping_required` again rather than being remapped, and changing it reports `alias_conflict`. Removing it from the project returns the key to unmapped, so the next request provisions a fresh connector that needs new consent; the removed connector's grants are not reused.

Changing the key in source also provisions a fresh connector, but that is a workaround, not a recovery path.

### Concurrency

Concurrent cold starts, retries, and redeployments for the same `(project, key)` converge on one connector. A request that loses a race may get a retryable `503`, or may briefly use its own connector; Connect then keeps the key on the oldest connector provisioned for it and releases it from the others, which keep their attachments and grants. A failure between creating and attaching a connector is repaired by the next request rather than leaving an orphan. User-created duplicates are never released automatically and stay `ambiguous`.

### Environments

The current OIDC initial-environment policy stays: a development deployment can attach development, preview, and production; preview can attach preview and production; production attaches production only; a custom environment attaches only itself. Later requests from an unattached environment report `attachment_required` and never widen the attachment; granting it requires a user. Every token and authorization operation is still validated server-side, even when the SDK caches the resolved connector.

### Responses

A resolved connector is returned with its canonical ID: `201` when this request created it, `200` otherwise. Errors are machine-readable:

| Response                                 | Meaning                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `400 bad_request`                        | Empty `projectUid`, or combined with an unsupported option.                                         |
| `404 project_uid_unavailable`            | `connex-project-uid` is off for the team.                                                           |
| `409 connector_setup_required`           | A user must act. `retryable: false`, a `reason` from the table below, and `connectorId` when known. |
| `409 conflict`                           | Creation failed in a way retrying does not fix.                                                     |
| `503 connector_provisioning_in_progress` | Another request is resolving or provisioning the same key; `retryable: true`.                       |

| `reason`                 | Produced when                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `ambiguous`              | Several connectors match and none can be chosen safely.                                                        |
| `alias_conflict`         | A connector matching the key by name already has a different project UID in this project.                      |
| `attachment_required`    | The connector mapped to the key, or with the key as its team UID, is not attached to this environment.         |
| `attachment_removed`     | A connector Connect provisioned or auto-linked for the key was removed from the project.                       |
| `project_uid_removed`    | A connector Connect provisioned for the key had its project UID cleared or changed.                            |
| `configuration_mismatch` | The connector the key resolves to is for a different server or has weaker grants, egress, or forwarded claims. |
| `mapping_required`       | An unmapped connector matching the key by name is attached to this project; a user must map or remove it.      |
| `connector_unavailable`  | The resolved connector was deleted or became unavailable while the request was resolving it.                   |

Ordinary callers see a redacted message; nothing about unrelated team resources or privileged settings is exposed.

## Relationship to `connex-project-uid`

This extends the existing team flag rather than adding a new one or changing user-authorized `projectUid` writes. With the flag on, an OIDC caller may resolve or provision a connector by its own project UID under the rules above. Requests without `projectUid` keep today's exact team-UID behavior. With the flag off, OIDC `projectUid` requests return `404` and nothing is resolved or created. Turning the flag off never deletes mappings or makes a key silently resolve to a different team connector.

## Adapter and eve rollout

`@vercel/connect/eve` currently posts the authored string as `uid`. Its managed OAuth path will send `projectUid` instead and use the returned connector ID for `getToken`, authorization start and completion, revocation, and cache eviction. It will map `connector_setup_required` to a non-retryable authorization failure that names the connector and the reason, and `connector_provisioning_in_progress` to a retryable one. On `404 project_uid_unavailable`, and on the `403` from Connect versions that reject OIDC project UIDs, it falls back to provisioning by team UID. Caches will be partitioned by project, environment, endpoint, key, and configuration; a cached ID is not proof the connector is still attached. Exact `scl_...` references and `autoProvision: false` keep working for intentionally team-wide references.

Making bare `connect("linear")` lazy changes the meaning of an existing UID. Today `eve integration connect` patches source to the team-wide UID it created, typically `connect("mcp.linear.app/linear")`, and leaves the attachment without a project UID. The exact-UID rule above keeps that source working unchanged, with no second connector. Fresh `connect("linear")` source in a project that already has that connector reports `mapping_required` once; after a user maps it, the deployment uses the same connector and grants. When matching is ambiguous or the name is taken, a user must also set it up; `connect({ connector: "mcp.linear.app/linear", autoProvision: false })` remains available for exact references.

Once the contract ships, eager setup will write the project-local key on the attachment and leave `connect("linear")` in source instead of patching it. Bespoke app-installation, JWT-bearer, API-key, trigger, and custom-creation setups stay eager.

## Rollout order

1. **Connect API:** ship OIDC `projectUid` resolution and provisioning. With the flag off it returns `404` and changes nothing.
2. **SDK:** release `@vercel/connect` with the adapter changes above. It handles both the old `403` and the new `404`.
3. **Flag:** enable `connex-project-uid` per team, internal teams first, until it is on for every team or removed.
4. **Registry:** only after step 3 completes, switch eve registry entries to bare keys, drop `integration connect` setup for verified standard user-managed OAuth entries, and require the minimum `@vercel/connect` version from step 2. Update validation and published connection docs, and keep an explicit operator path for sharing an existing connector or repairing an environment attachment. A registry install provides source; OAuth consent still happens on first use.

Step 4 is gated on the flag being on everywhere because, for a team with the flag off, the adapter's fallback would create a team-wide connector with UID `linear` for the first project and give every later project a `409`. An older `@vercel/connect` sends a team UID regardless of the flag and hits the same `409`, so the registry also needs the version floor.

## Validation gates

- With the flag on, two blank projects in one team using `connect("linear")` get distinct connectors, and an unattached team connector with UID `linear` is neither mapped nor attached. With the flag off, nothing is provisioned by project UID.
- Source patched to a team UID reuses that connector only while it is attached to the requesting project and environment. Fresh `connect("linear")` source with a compatible legacy connector attached reports `mapping_required` with its ID and writes nothing; once a user maps it, it resolves with its grants in every attached environment. Several matches report `ambiguous`.
- Concurrent cold starts converge on one connector, and later token requests resolve the key unambiguously. A failure after creation and before attachment is repaired on retry rather than duplicated.
- Removing a provisioned or auto-linked connector from the project, or clearing or changing its project UID, reports setup required with its connector ID instead of provisioning. Reconnecting it restores access with its grants; deleting it leads to a fresh connector that needs new consent.
- Clearing the project UID of a user-mapped connector reports `mapping_required` instead of remapping it; removing it from the project provisions a fresh connector.
- Development-first creation works in production; production-first creation reports setup required in development; attaching the environment and retrying works without a redeploy. Custom environments stay exact-only.
- Invalid server URLs, weaker egress or grants, name collisions, and ambiguous matches fail safely. Exact connector IDs and requests without `projectUid` keep their behavior.
- The SDK uses the returned ID throughout the OAuth and token lifecycle. Tests cover Connect's real resolution and concurrency behavior, not just a mocked adapter.
- Registry entries switch only after the flag is on for every team, and each switched entry declares the minimum `@vercel/connect` version.

Storage, locking, and resolver internals are documented with the Connect API rather than here.
