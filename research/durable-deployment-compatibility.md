---
issue: https://github.com/vercel/eve/issues/1765
status: proposed
last_updated: "2026-08-26"
---

# Durable deployment compatibility

## Purpose

eve intentionally routes each new turn to the latest deployment so running
agents adopt new instructions, tools, models, and framework behavior without
waiting for an existing session to finish. The long-lived session driver stays
pinned to the deployment that created it, while each turn is a fresh child
workflow on latest code.

That topology makes deployment compatibility an eve protocol problem. An old
driver can send durable input to a new turn, the new turn can return state and
control actions to the old driver, and a new producer can resume hooks owned by
an old workflow. TypeScript cannot protect these exchanges because both sides
are compiled independently.

```text
old pinned driver
    │ serialized input and session state
    ▼
latest turn workflow
    │ driver action, session state, and hook payloads
    ▼
old pinned driver
```

The goal is to prevent a deployment from becoming latest when it breaks a
durable contract still used by a live session. Agents should continue to take
the newest code that passes the regression gate; compatibility must not require
pinning an agent to an old deployment for its full lifetime.

## Compatibility model

A value is a durable contract when it can be produced and consumed by different
eve deployments or read after the deployment that wrote it has changed. The
initial inventory includes:

- stable cross-deployment workflow IDs and their input versions;
- durable session snapshots;
- session-inbox payloads;
- persisted message-stream events; and
- attachment references carried across step boundaries.

Stable workflow IDs are immutable routing keys. A workflow input without an
explicit current version is recorded as `null`; this identifies an unsafe gap
rather than claiming compatibility. Every current stable workflow input now
emits version 1 and treats the prior unversioned shape as version 0 for
migration. The manifest records finite accepted sets where current code proves
them and leaves schema hashes `null` until a family adopts a canonical schema.

Every versioned family follows the same rules:

- Changing a persisted shape requires a new version.
- Current code must retain a migration or decoder for every supported version.
- Producers must encode for the consumer capability when the consumer can be
  pinned to an older deployment.
- Unknown versions fail explicitly and leave the durable owner recoverable;
  they must not fall through to a legacy interpretation.
- New driver behavior uses capability negotiation. A latest turn must not send
  a new control-action kind to a pinned driver that did not advertise support.

## Build manifest

Every eve package build emits `dist/durable-contract-manifest.json`. Format 2 is
a deterministic inventory of contract identities, accepted versions, and
per-version schema hashes:

```json
{
  "builtWithEve": "0.45.2",
  "dataContracts": [
    {
      "acceptedVersions": [1],
      "currentVersion": 1,
      "name": "attachmentRef",
      "schemaHashes": { "1": null }
    },
    {
      "acceptedVersions": [1],
      "currentVersion": 1,
      "name": "durableSession",
      "schemaHashes": { "1": null }
    },
    {
      "acceptedVersions": null,
      "currentVersion": 23,
      "name": "messageStream",
      "schemaHashes": null
    },
    {
      "acceptedVersions": [0, 1],
      "currentVersion": 1,
      "name": "sessionInboxWire",
      "schemaHashes": {
        "0": null,
        "1": "sha256:81817bf2fcd37fc960ba6dccf5cef88ac85709309d439df421cf2580525ee1d5"
      }
    }
  ],
  "formatVersion": 2,
  "kind": "eve-durable-contracts",
  "workflows": [
    {
      "acceptedInputVersions": [0, 1],
      "inputSchemaHashes": { "0": null, "1": null },
      "inputVersion": 1,
      "name": "sessionTimeoutWorkflow",
      "workflowId": "workflow//eve//sessionTimeoutWorkflow"
    },
    {
      "acceptedInputVersions": [0, 1],
      "inputSchemaHashes": { "0": null, "1": null },
      "inputVersion": 1,
      "name": "taskRunWorkflow",
      "workflowId": "workflow//eve//taskRunWorkflow"
    },
    {
      "acceptedInputVersions": [0, 1],
      "inputSchemaHashes": { "0": null, "1": null },
      "inputVersion": 1,
      "name": "turnWorkflow",
      "workflowId": "workflow//eve//turnWorkflow"
    },
    {
      "acceptedInputVersions": [0, 1],
      "inputSchemaHashes": { "0": null, "1": null },
      "inputVersion": 1,
      "name": "workflowEntry",
      "workflowId": "workflow//eve//workflowEntry"
    }
  ]
}
```

### Manifest guarantees

The manifest is a complete, lexically sorted inventory of the durable contracts
owned by the build. For each contract, `currentVersion` identifies the version
the build writes and `acceptedVersions` identifies the historical versions it
can read. A `null` accepted-version set means that support has not yet been
modeled as a truthful finite list; it does not mean the contract accepts no
versions.

Each accepted version may also have a canonical schema fingerprint. A `null`
fingerprint means the version is recognized but its schema has not yet been
formalized. The message stream has a current version but does not yet declare a
complete historical support set or canonical schemas, so its accepted versions
and schema hashes remain `null`.

The session-inbox v1 contract currently has a canonical JSON Schema. The build
recursively sorts the schema's object keys before computing its SHA-256
fingerprint, so key ordering does not change its identity. Schema generation and
hashing stay in build-only code so Zod and `node:crypto` do not enter the runtime
registry or workflow bundles. The manifest also excludes timestamps, absolute
paths, Git revisions, and deployment-local values, ensuring identical package
inputs produce identical bytes.

### Transitional compatibility

Task workflow input renamed `continuationToken` to `taskInboxToken`. Version 1
writes both fields so a new producer can still start an older task workflow
during a mixed-version deployment, and its migration accepts either historical
name. The other version-1 workflow-input migrations preserve the prior
unversioned fields and add the version marker.

Connection authorization callbacks use the same target-aware `sessionInboxWire`
protocol as session deliveries. Before sending a callback, the producer
inspects the target hook and encodes the payload for the version its pinned
workflow can decode. The authorization workflow decodes the envelope before
interpreting it. An unknown version is reported through the dropped-wire step
and leaves the authorization challenge pending rather than consuming or
reinterpreting it.

### Registry enforcement

The durable-contract registry is also the source of truth for stable workflow
IDs. Runtime references, workflow bundling, and manifest generation all derive
their IDs from that registry. Tests compile every stable workflow declaration
and compare its emitted ID with the registered value, so an accidental function
rename, removed workflow directive, changed routing key, or stale version
declaration fails before release.

### Regression gate

The regression gate builds the manifest for both the pull request's base commit
and candidate commit, then compares the generated artifacts. It does not use a
checked-in baseline that could be changed in the same pull request to hide a
breaking change.

The comparison rejects removing a durable contract, changing a stable workflow
ID, decreasing a current version, removing a previously accepted version, or
changing or removing the schema fingerprint of an existing version. When a
contract advances to a new current version, the candidate must continue to
accept the previous current version.

The comparator accepts the original format-1 manifest as a bootstrap input
while format 2 adds accepted-version sets and schema fingerprints. A candidate
may add a fingerprint where none was previously declared, but it may not
contradict or remove an existing compatibility claim. The manifest gate detects
structural regressions only; historical fixtures, mixed-version scenarios, and
suspended-session canaries provide the behavioral checks below.

## Admission pipeline

Compatibility enforcement is layered because no static check can prove the
semantics of arbitrary JavaScript:

```text
candidate build
    │
    ├── durable contract regression gate
    ├── historical payload fixtures
    ├── mixed-version continuation scenarios
    └── suspended-session canary
              │
              ▼
      promote as regression-gated latest
```

The build comparison rejects removed stable IDs, changed schemas without a
version bump, missing migrations, removed supported versions, and control
actions that lack capability negotiation. Frozen historical payloads prove the
candidate still decodes every declared version.

Mixed-version scenarios then exercise behavior that schemas cannot prove. They
start representative sessions under each supported protocol cohort, promote
the candidate in the development world, and continue those sessions through
parked turns, active turns, cancellation, runtime actions, subagents, tasks,
and timeouts.

The first required local cohort builds the published eve 0.30.8 handler and the
candidate handler independently against one test-only promotable Workflow
World. It proves the historical session driver remains deployment-affine while
its next turn is created and delivered by the promoted candidate. Additional
cohorts and suspension points are added only when they represent a distinct
shipped protocol contract; package releases alone do not grow the matrix.

Production routing ultimately targets the latest regression-gated deployment
rather than the most recently created deployment. Promotion is not
long-lived blue/green routing: after the gate passes, every new turn takes the promoted
code. The pointer exists to keep an unverified build out of the latest path and
to provide an immediate demotion control if a semantic regression escapes the
build gate.

Two implementation boundaries remain outside this stack. Turn-control producer
gating builds on the fail-loud decoder and terminal skew path in #2625; it should
land after that work rather than duplicate its workflow-bundle changes. An
immediate production demotion control requires Vercel's dynamic
`resolve-latest-deployment` path to return an audited regression-gated deployment. An
eve-only resolver can protect newly deployed drivers, but it cannot retrofit
that behavior into older immutable drivers already calling the platform's
existing latest resolver.

## Why history replay is insufficient

Workflow history replay is useful when new code must reconstruct an existing
workflow run. It is not the primary compatibility proof for eve's latest-turn
topology: the old driver remains on its original deployment and the latest turn
starts as a new workflow run with fresh history. The risky boundary is the
serialized protocol between those runs.

Replay also cannot prove semantic equivalence for step bodies or paths absent
from the sampled history. Contract comparison, historical fixtures, and
mixed-version execution directly test the boundary eve actually crosses.

## Compatibility horizon

The default session lifetime is 30 days, but `sessionTimeoutMs: false` permits
an unbounded session. Compatibility cannot therefore expire merely because the
default timeout elapsed.

Until eve enforces a maximum session lifetime, shipped decoders and migrations
must be treated as permanent. Removing a historical contract requires either a
product-level maximum compatibility window or an explicit operation that
migrates or terminates every session that can still produce or consume it.

## Rollout

The work proceeds in independently reviewable layers:

1. Inventory stable identities and current versions in a deterministic build
   manifest.
2. Version the remaining stable workflow inputs and formalize driver capability
   negotiation.
3. Apply declared schemas, migrations, and frozen fixtures to every durable
   hook family.
4. Compare candidate manifests with supported production cohorts and run the
   mixed-version CI matrix.
5. Route latest turns through an explicit regression-gated deployment
   pointer with pre-promotion canaries.

## Non-goals

- Pinning existing agents to old authored code.
- Adopting Temporal patch markers or replaying candidate code inside old runs.
- Introducing a second binary serialization format; Workflow continues to own
  byte serialization.
- Claiming that a build-time schema check proves application-level semantic
  equivalence.
- Defining a public authoring API in the foundation manifest release.
