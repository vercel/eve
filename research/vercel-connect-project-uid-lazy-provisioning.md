---
issue: "TBD (maintainer-requested research; no matching issue found)"
status: proposed
last_updated: "2026-10-17"
---

# Lazy Vercel Connect provisioning with project-local UIDs

## Objective

A registry connection currently works by syncing the eve source with a manual setup process that provisions a Vercel connector to the project.

```ts
import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
  auth: connect("linear"),
});
```

The first time a deployment uses the connection, Vercel Connect should resolve the connector this project uses for `"linear"`, or provision one for it, and the user should only see the OAuth consent prompt. Using the same `"linear"` connector label on a new project should provision a new project-specific connector. This should eliminate the need for an eager setup step from standard OAuth registry items, which is what blocks installing them from a remote session today.

## Background

### How `connect()` names a connector today

`connect("...")` takes either an opaque connector ID (`scl_...`) or a connector **team UID**: a human-readable name unique across the team, such as `mcp.linear.app/linear`. The adapter in `@vercel/connect/eve` passes the string to Connect's token and authorization endpoints, authenticated by the deployment's OIDC token, and Connect checks that the connector is attached to the requesting project and environment.

### Eager setup

Registry items get a working connector through eager setup. Installing an item runs `eve integration connect`, which needs a linked Vercel project and a logged-in Vercel CLI. It creates or selects a connector with `vercel connect create`, attaches it to the project, and patches the connection source to that connector's team UID, for example from `connect("linear")` to `connect("mcp.linear.app/linear")`.

This works, but it has to run where the CLI is logged in and the source can be rewritten. A remote session, such as an agent installing a registry item into a deployed project, has neither, so it cannot complete setup.

### `autoProvision`

`connect({ connector, autoProvision: true })` is the existing runtime alternative. When a token or authorization call reports the connector missing or not attached, the adapter posts the connection's URL and the authored string as `uid` to Connect's managed OAuth endpoint, using the deployment's OIDC token, then retries. Connect creates a connector with that team UID and attaches it to the requesting project, or reuses one already attached to the project and environment.

Because a team UID is unique across the team, this only works for one project per team. The first project to use `connect("linear")` creates the team connector `linear`. Every later project finds that UID taken by a connector it is not attached to and gets `409`, since a deployment token may not attach another project's connector to itself.

### The `connex-project-uid` flag

The `connex-project-uid` team flag adds **project UIDs**: an optional, private name on a project's attachment to a connector, local to that project. With the flag on, a user can set a project UID on an attachment, and token and authorization lookups from a project resolve a key as a project UID first, in the requester's exact environment, then as a team UID. Two projects can therefore map the same key, such as `linear`, to different connectors.

The flag only covers lookup. Project UIDs are written by users; deployment OIDC tokens are not allowed to set them, so that a lower environment cannot shadow the name a production deployment resolves. A deployment therefore cannot provision a connector under a project UID, and a key with no project mapping falls back to the team UID, which brings back the one-project-per-team limit above.

## Goals

- Bare keys such as `connect("linear")` resolve per project, so the same registry source works in every project of a team.
- The first use provisions the connector with no setup step; OAuth consent stays on first use.
- Source patched by today's eager setup keeps working with the connector it already has, without a second connector.
- Users stay in control. A deployment never maps a connector it did not create, never attaches a connector to another project, never widens the environments of an attachment, and respects a user removing a connector it provisioned.
- Concurrent cold starts and retries converge on one connector.
- No new eve authoring API.

## Non-goals

- Connections that need bespoke setup, such as app installation, JWT-bearer, API-key, trigger, or custom creation flows, keep eager setup.
- Sharing one connector across projects stays explicit: an `scl_...` ID, or a team UID with `autoProvision: false`.

## What changes

| Area                   | Today                                                                                          | Proposed                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect managed OAuth  | Deployment tokens provision by team UID only, and may not send `projectUid`.                   | Deployment tokens may send `projectUid` to resolve or provision a connector by project UID, under the [rules below](#connect-resolution-by-project-uid).      |
| `@vercel/connect/eve`  | `autoProvision` sends the key as `uid`.                                                        | `autoProvision` sends the key as `projectUid`, falls back to `uid` when the API does not support it, and maps setup errors.                                   |
| eve setup and registry | Eager setup patches source to a team UID; registry items ship a placeholder key and run setup. | Standard OAuth registry items ship a bare key and no setup step; eager setup, where it still runs, maps the key on the attachment instead of patching source. |

## Connect: resolution by project UID

This extends `connex-project-uid` rather than adding a new flag. Requests without `projectUid` keep today's exact team-UID behavior. With the flag off, `projectUid` requests return `404 project_uid_unavailable` and resolve or create nothing. Turning the flag off never deletes mappings or makes a key silently resolve to a different connector.

Only URL-backed managed OAuth connections use this path. The project and environment come from the deployment's OIDC token, never from the request body. Opaque connector IDs, app or JWT-bearer setups, provider-specific setups, triggers, and connections without a provisionable URL keep their existing behavior; combining `projectUid` with those options is a `400`.

Resolution for a `(project, environment, key)` request only considers connectors already attached to the requesting project. It never selects a connector merely because it exists elsewhere in the team, and no deployment request attaches a connector to another project or widens its environments.

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

## `@vercel/connect/eve` adapter

With `autoProvision: true`, the adapter will send the authored key as `projectUid` instead of `uid`. On `404 project_uid_unavailable`, and on the `403` from Connect versions that reject `projectUid` from deployment tokens, it will fall back to provisioning by team UID, so it can ship before or after the API.

For a few minutes after provisioning, the adapter will use the returned connector ID for token, authorization, revocation, and cache-eviction calls. Lookup by key is eventually consistent and may not yet find a connector Connect just created; the ID does not depend on that lookup. Afterwards the adapter addresses the connector by key again, so a later remapping takes effect. Cached IDs are scoped to the key, the connection's server URL, the Connect endpoint, and an explicitly configured Vercel token. A cached ID is not proof the connector is still attached: when Connect rejects it, the adapter drops it and resolves the key again.

`connector_setup_required` will map to a non-retryable authorization failure that names the connector and the reason, and `connector_provisioning_in_progress` to a retryable one. Exact `scl_...` references and `autoProvision: false` keep working unchanged.

## eve setup and registry

Standard user-managed OAuth registry entries will ship a bare key, such as `connect("linear")`, and drop their `integration connect` setup step. A registry install then only provides source.

Making bare `connect("linear")` lazy changes the meaning of an existing UID. Today `eve integration connect` patches source to the team-wide UID it created, typically `connect("mcp.linear.app/linear")`, and leaves the attachment without a project UID. The exact-UID rule above keeps that source working unchanged, with no second connector. Fresh `connect("linear")` source in a project that already has that connector reports `mapping_required` once; after a user maps it, the deployment uses the same connector and grants. When matching is ambiguous or the name is taken, a user must also set it up; `connect({ connector: "mcp.linear.app/linear", autoProvision: false })` remains available for exact references.

Where eager setup still runs, it will write the key as the attachment's project UID and leave `connect("linear")` in source instead of patching it, so eager and lazy installs end in the same state.

Registry entries can switch only once `connex-project-uid` is on for every team and they require an `@vercel/connect` version that sends `projectUid`. Otherwise the adapter falls back to team UIDs, and the first project in a team takes the team UID `linear` while every later project gets `409`.

Storage, locking, and resolver internals are documented with the Connect API rather than here.
