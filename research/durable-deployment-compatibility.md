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
the newest approved code; compatibility must not require pinning an agent to an
old deployment for its full lifetime.

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
explicit version is recorded as `null`; this identifies an unsafe gap rather
than treating the historical shape as version zero or claiming compatibility.
Every current stable workflow input now emits version 1 and treats the prior
unversioned shape as version 0 for migration. Existing numeric versions identify
only the current emitted contract. Supported version ranges and schema identities
are added when each family adopts a declared schema and migration chain.

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

Every eve package build emits `dist/durable-contract-manifest.json`. The first
format is a deterministic inventory of the contract identities the package
currently owns:

```json
{
  "builtWithEve": "0.45.2",
  "dataContracts": [
    { "currentVersion": 1, "name": "attachmentRef" },
    { "currentVersion": 1, "name": "durableSession" },
    { "currentVersion": 23, "name": "messageStream" },
    { "currentVersion": 1, "name": "sessionInboxWire" }
  ],
  "formatVersion": 1,
  "kind": "eve-durable-contracts",
  "workflows": [
    {
      "inputVersion": 1,
      "name": "sessionTimeoutWorkflow",
      "workflowId": "workflow//eve//sessionTimeoutWorkflow"
    },
    {
      "inputVersion": 1,
      "name": "taskRunWorkflow",
      "workflowId": "workflow//eve//taskRunWorkflow"
    },
    {
      "inputVersion": 1,
      "name": "turnWorkflow",
      "workflowId": "workflow//eve//turnWorkflow"
    },
    {
      "inputVersion": 1,
      "name": "workflowEntry",
      "workflowId": "workflow//eve//workflowEntry"
    }
  ]
}
```

The artifact is complete and lexically sorted. It contains no timestamp,
absolute path, Git SHA, or deployment-local value, so identical package inputs
produce identical bytes.

The version-1 task input dual-writes `taskInboxToken` and its historical name,
`continuationToken`, so a new producer can still start an older task workflow
during a deployment transition. Its migration accepts either pre-version name;
the other version-1 migrations are identity stamps that preserve additive
fields.

Connection authorization callbacks use the same target-aware `sessionInboxWire`
boundary as stable and continuation session deliveries. The callback route
inspects the target hook before encoding, including the existing markerless
stable-inbox classification, and the authorization source decodes before it
interprets callback payloads. An unknown payload version is reported through the
dropped-wire step and leaves the authorization challenge parked rather than
reinterpreting or consuming it silently.

The registry that creates the manifest also owns the stable workflow IDs used
by runtime references and the workflow bundler. Tests transform every real
stable workflow declaration and compare the emitted ID with the registry. A
renamed function, removed directive, changed routing key, or stale version
inventory therefore fails before release.

The v1 manifest is not yet a compatibility verdict. Later manifest formats add
the accepted version set and schema identity needed to compare a candidate with
historical production cohorts. Recording only facts enforced by current code
avoids publishing unsupported guarantees from the foundation release.

## Admission pipeline

Compatibility enforcement is layered because no static check can prove the
semantics of arbitrary JavaScript:

```text
candidate build
    │
    ├── manifest and schema comparison
    ├── historical payload fixtures
    ├── mixed-version continuation scenarios
    └── suspended-session canary
              │
              ▼
      promote as approved latest
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

Production routing ultimately targets the latest compatibility-approved
deployment rather than the most recently created deployment. Promotion is not
long-lived blue/green routing: after approval, every new turn takes the promoted
code. The pointer exists to keep an unverified build out of the latest path and
to provide an immediate demotion control if a semantic regression escapes the
build gate.

Two implementation boundaries remain outside this stack. Turn-control producer
gating builds on the fail-loud decoder and terminal skew path in #2625; it should
land after that work rather than duplicate its workflow-bundle changes. An
immediate production demotion control requires Vercel's dynamic
`resolve-latest-deployment` path to return an audited approved deployment. An
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
5. Route latest turns through an explicit compatibility-approved deployment
   pointer with pre-promotion canaries.

## Non-goals

- Pinning existing agents to old authored code.
- Adopting Temporal patch markers or replaying candidate code inside old runs.
- Introducing a second binary serialization format; Workflow continues to own
  byte serialization.
- Claiming that a build-time schema check proves application-level semantic
  equivalence.
- Defining a public authoring API in the foundation manifest release.
