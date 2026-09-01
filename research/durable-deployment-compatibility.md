---
issue: https://github.com/vercel/eve/issues/1765
status: proposed
last_updated: "2026-09-01"
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

The manifest is a lexically sorted inventory of the durable contracts registered
by the build. The initial source-controlled registry makes those declarations
explicit but does not discover unregistered boundaries; structural completeness
requires the construction rules below. For each registered contract,
`currentVersion` identifies the version the build writes and `acceptedVersions`
identifies the historical versions it can read. A `null` accepted-version set
means that support has not yet been modeled as a truthful finite list; it does
not mean the contract accepts no versions.

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

### Boundary construction

A manually maintained inventory cannot prevent code from creating a durable
boundary without registering it. The target invariant is therefore: code cannot
use an eve-owned primitive across a deployment boundary without supplying an
explicit contract or ownership declaration. The registry becomes the composition
root for those declarations, and the manifest becomes an output rather than a
parallel list.

#### Problem

The current workflow boundary is assembled from independent pieces: a workflow
function, a stable reference, an input constructor, a migration call, and a
registry entry. `startWorkflowPreferLatest` still accepts an arbitrary workflow
function or metadata reference and untyped argument tuple. A caller can
therefore create a new cross-deployment boundary while omitting its stable
identity, versioned input, migration, or manifest declaration. TypeScript sees
the producer and consumer in one checkout and cannot detect that their deployed
copies will execute different code.

The proposed `defineDurableWorkflow` is an internal eve API that makes those
pieces one declaration. It is not an implemented API or a public agent-authoring
surface. Its purpose is to make the unsafe construction unavailable: a workflow
cannot route to latest unless it carries the contract needed to cross that
deployment boundary.

#### Proposed API

The conceptual API separates the durable value contract from the workflow that
uses it:

```ts
const turnWorkflowInput = defineDurableValue<TurnWorkflowInput>({
  name: "turnWorkflow.input",
  canonicalVersion: 1,
  writeVersion: 1,
  initialVersion: 0,
  versions: {
    0: { decode: decodeTurnWorkflowInputV0, schema: null },
    1: {
      decode: decodeTurnWorkflowInputV1,
      schema: buildOnlySchema(() => import("./turn-workflow-input-v1.schema.js")),
    },
  },
  encoders: {
    1: encodeTurnWorkflowInputV1,
  },
  migrations: {
    0: turnWorkflowInputV0ToV1,
  },
});

async function runTurnWorkflow(input: TurnWorkflowInput): Promise<void> {
  "use workflow";
  await runTurn(input);
}

export const turnWorkflow = defineDurableWorkflow({
  name: "turnWorkflow",
  input: turnWorkflowInput,
  result: durableVoid("turnWorkflow.result"),
  run: runTurnWorkflow,
});

await turnWorkflow.startLatest(input);
```

The intended type-level shape is:

```ts
interface DurableValueContract<TCurrent> {
  readonly acceptedVersions: readonly number[];
  readonly canonicalVersion: number;
  readonly encodableVersions: readonly number[];
  readonly name: string;
  readonly schemaHashes: Readonly<Record<number, string | null>>;
  readonly writeVersion: number;
  decode(value: unknown): TCurrent;
  encode(value: TCurrent, targetVersion?: number): unknown;
}

interface DurableWorkflowDefinition<TName extends string, TInput, TResult> {
  readonly name: TName;
  readonly input: DurableValueContract<TInput>;
  readonly result: DurableValueContract<TResult>;
  readonly run: (input: TInput) => Promise<TResult>;
}

declare const durableWorkflowBrand: unique symbol;

interface DurableRun<TResult> {
  readonly runId: string;
  readonly returnValue: Promise<TResult>;
}

interface DurableWorkflow<TName extends string, TInput, TResult> {
  readonly [durableWorkflowBrand]: TName;
  readonly name: TName;
  readonly workflowId: string;
  readonly input: DurableValueContract<TInput>;
  readonly result: DurableValueContract<TResult>;
  startLatest(input: TInput, options?: DurableStartOptions): Promise<DurableRun<TResult>>;
}

declare const exactDeploymentBrand: unique symbol;
type ExactDeploymentId = string & { readonly [exactDeploymentBrand]: true };

function exactDeploymentId(value: string): ExactDeploymentId;

interface DurableWorkflowTestControl {
  startOnDeployment<TName extends string, TInput, TResult>(
    workflow: DurableWorkflow<TName, TInput, TResult>,
    deploymentId: ExactDeploymentId,
    input: TInput,
    options?: DurableStartOptions,
  ): Promise<DurableRun<TResult>>;
}
```

`name` is the immutable contract identity. `defineDurableWorkflow` derives the
stable Workflow routing ID as `workflow//eve//${name}`. The string is not secret,
but the latest-start facade accepts only the branded definition created by this
factory, never a bare ID or generic workflow reference. Changing `name` is
therefore a durable contract change rejected by the manifest regression gate.

`input` owns the complete value crossing into the workflow. Its
`canonicalVersion` is the representation delivered to `run`, while
`writeVersion` is the representation emitted by producers. Separating them
allows a reader-first release to accept and canonicalize version N+1 while still
writing version N for rollback safety. `initialVersion` identifies a historical
unversioned cohort when one exists, `versions` records accepted wire versions
and canonical schemas, `encoders` defines `encodableVersions` by projecting the
canonical value into each permitted target version, and `migrations` contains
one pure forward transform for each step to the canonical representation.
Accepted versions, encodable versions, and schema hashes are derived from this
definition rather than repeated manually in the manifest registry.

The schema reference is build-only metadata. The package build imports it to
produce a canonical fingerprint, while the workflow transformer emits a reduced
runtime descriptor containing only version numbers, dependency-free decoders,
encoders, and migrations. Each version's `decode` function performs the runtime
wire validation needed before migration; Zod and `node:crypto` do not enter the
workflow bundle.

`result` is required so a workflow cannot accidentally expose an unversioned
return value. Workflows that communicate only through hooks declare the built-in
`durableVoid(name)` contract. Other workflows declare a versioned result
contract, and the returned `DurableRun` decodes the persisted result before
exposing it to the caller. Direct Workflow results do not expose receiver
capability negotiation, so their `writeVersion` may advance only when every
supported caller cohort accepts it. A result that needs per-consumer negotiation
must instead travel over a durable inbox contract.

Existing workflows bootstrap their historical raw return value as unversioned
result version 0. Their first result contract must decode that raw shape, retain
an encoder that reproduces it, and keep `writeVersion: 0` while any legacy caller
can remain. Frozen historical-result fixtures prove the v0 encoder preserves the
old bytes and semantics. The contract may emit a versioned result only after all
legacy callers have rotated or the compatibility horizon has expired.

`run` remains a named top-level workflow function so the existing workflow
transformer can discover and compile it. `defineDurableWorkflow` associates that
compiled declaration with its contract; the compiler verifies the directive and
binding rather than requiring an object-property workflow syntax. The generated
entry calls `input.decode`, which parses the envelope, selects and validates the
declared wire version, applies forward migrations, validates the canonical
shape, and returns only the canonical input to `run`. Any unsupported version or
failed migration is reported as durable version skew before application logic
runs.

`startLatest` replaces direct calls to `startWorkflowPreferLatest`. It accepts a
canonical domain value rather than a raw argument tuple, encodes it at the
contract's `writeVersion`, and starts the definition's hidden workflow reference.
It preserves existing routing semantics: production and `eve dev` request the
latest deployment, preview stays on its serving deployment, and worlds that do
not implement latest routing fall back to the current deployment.
The separately exported `DurableWorkflowTestControl` is restricted by the import
guard to compatibility tests and canaries. Its `startOnDeployment` accepts only a
validated `ExactDeploymentId`, not an arbitrary string. The guarded
`exactDeploymentId` constructor rejects empty values and symbolic selectors such
as `"latest"` at runtime. Exact starts use the same mandatory encoding path. The
underlying generic reference is not exported from either facade.

The returned definition supplies its workflow ID and named input/result contract
metadata to the bundler and build manifest. Results are emitted as ordinary data
contract entries referenced by the workflow entry. A manifest format that
supports staged reader-first rollout records canonical and write versions
separately; the existing format-2 `currentVersion` remains their shared bootstrap
value until that format lands. There is no second workflow ID, version list, or
schema table for an engineer to keep synchronized.

The next manifest format makes those relationships explicit:

```json
{
  "dataContracts": [
    {
      "acceptedVersions": [0, 1, 2],
      "canonicalVersion": 2,
      "encodableVersions": [1, 2],
      "name": "turnWorkflow.input",
      "schemaHashes": { "0": null, "1": "sha256:...", "2": "sha256:..." },
      "writeVersion": 1
    },
    {
      "acceptedVersions": [0, 1],
      "canonicalVersion": 1,
      "encodableVersions": [0, 1],
      "name": "turnWorkflow.result",
      "schemaHashes": { "0": null, "1": "sha256:..." },
      "writeVersion": 0
    }
  ],
  "formatVersion": 3,
  "workflows": [
    {
      "inputContract": "turnWorkflow.input",
      "name": "turnWorkflow",
      "resultContract": "turnWorkflow.result",
      "workflowId": "workflow//eve//turnWorkflow"
    }
  ]
}
```

For comparison with format 2, the old inline workflow input fields normalize to
a synthetic `${workflow.name}.input` contract whose canonical and write versions
both equal the old `inputVersion`. Each historical raw return value normalizes to
a synthetic `${workflow.name}.result` contract at unversioned version 0. The
first explicit result definition must use that identity, accept and encode v0,
and continue writing v0; it cannot replace the bootstrap gap with an unrelated
versioned envelope. Format 3 validates that every workflow link resolves to a
declared data contract.

A format-2 contract with `acceptedVersions: null` keeps that unknown support set
when normalized. Its current version is the only proven encodable and writable
version. The gate rejects a write-version change until a reader-only release has
declared a finite accepted set that includes the proposed write version. Unknown
support therefore blocks an unsafe advance rather than being guessed into a
format-3 guarantee.

The regression comparator additionally prevents canonical or write version
decreases, requires the candidate to accept the base build's write version,
requires the base build to accept the candidate's write version for rollback
safety, and preserves every previously advertised accepted and encodable version.
The promotion gate applies the write-version check to every supported production
cohort, not only the pull request base. The normal schema identity and stable
workflow ID rules continue to apply.

#### Runtime lifecycle

The definition governs the boundary in both directions:

```text
producer domain input
    │ input.encode at writeVersion
    ▼
persisted { version, ... }
    │ Workflow start on an exact resolved deployment
    ▼
input.decode: wire validation → forward migrations → canonical validation
    │
    ▼
run(canonical input)
    │ result.encode at writeVersion
    ▼
versioned durable result
    │ DurableRun decodes
    ▼
caller receives canonical result
```

Forward migrations solve an old-producer-to-new-consumer transition. They do not
make a new write readable by code that has already been rolled back. A new input
version therefore follows a reader-first rollout: deploy support for reading the
new version while still writing the old version, establish that deployment as
the rollback floor, and only then begin writing the new version. Historical
dual-write fields such as `continuationToken` and `taskInboxToken` remain an
explicit bridge where an old target cannot negotiate its version.

#### Which boundaries require a definition

The criterion is not whether a value is important or serialized. Every boundary
whose producer and consumer may execute different code needs an explicit owner.
Values interpreted by eve across deployments need a durable contract; opaque
values may instead declare origin pinning, and Workflow-runtime-owned journals
remain owned by that runtime. The owner is specialized to the transport:

| Boundary                                                          | Required owner                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| Workflow routed across deployments                                | Durable workflow plus input and result value contracts              |
| Hook, callback, or inbox resumed by another deployment            | Durable inbox contract with consumer capability negotiation         |
| Session snapshot or framework state read after a deployment       | Durable value or state contract with forward migrations             |
| Event stream containing records from multiple deployments         | Durable stream contract with per-event versions and projections     |
| Attachment or reference interpreted by different deployment code  | Durable value contract                                              |
| Opaque dependency continuation or executable closure              | Origin-deployment pinning, or an owned adapter and explicit version |
| In-memory value consumed entirely within one pinned execution     | No durable contract                                                 |
| Workflow-runtime journal interpreted only by the Workflow runtime | Owned by the Workflow runtime, not duplicated by eve                |

An opaque or executable value does not become safe merely by adding a numeric
version. If eve cannot define a deterministic data migration, the operation must
resume on its originating deployment, be invalidated, or cross an explicit epoch
boundary. The contract system should expose that ownership decision rather than
claim compatibility it cannot provide.

#### Related durable definitions

`defineDurableWorkflow` covers workflow routing, input, and return values. It
does not implicitly make every value used by the workflow compatible.
Turn-control messages, inbox payloads, session state, streams, and attachment
references are independent boundaries and use sibling definitions:

- A durable inbox definition owns hook creation, target capability inspection,
  target-aware encoding, resume, decode, and its manifest entry.
- A durable state definition owns its state key, versions, migrations,
  validation, reads, writes, and manifest entry.
- A durable stream definition owns event versions, append encoding, projection,
  and its manifest entry.

Family-branded workflow and hook handles prevent a task or callback payload from
being sent to the wrong boundary in typed code. The private brand carries the
literal contract name, so handles from two definitions are not structurally
interchangeable even when their payload types match. Persisted metadata verifies
the contract identity and supported version at runtime, where TypeScript brands
are no longer present.

#### Construction enforcement

Raw latest-start, hook, stream, durable-state, attachment-reference, and opaque
continuation primitives remain internal to contract-owned facades. A mechanical
import guard rejects their use from other production modules, with narrow
allowlists for the facades, historical test fixtures, and Workflow-runtime-owned
journals. Origin-pinned values use an ownership declaration with strategy
`"origin-deployment"` rather than a migration contract. This closes the bypass
that would otherwise make coverage depend on reviewer memory.

The same definitions drive runtime references, workflow bundling, and manifest
generation. Build checks reject duplicate identities, missing version steps or
target encoders, and stable workflow declarations that do not match their
definitions. An accidental function rename, removed workflow directive, changed
routing key, stale version declaration, or unregistered latest-routed workflow
therefore fails before release.

This construction proves that every use of an eve-owned durable primitive has an
explicit owner. For contract-owned values it also proves that identity, versions,
migrations, encoders, and generated manifest entries agree. Origin-pinned and
Workflow-runtime-owned values are checked against their declared ownership
strategy instead of being required to publish migrations. None of these checks
prove semantic equivalence of arbitrary JavaScript. A migration can preserve a
schema while changing the meaning of a pending tool call, so historical
mixed-version scenarios and suspended-session canaries remain required.

### Regression gate

The regression gate builds the manifest for both the pull request's base commit
and candidate commit, then compares the generated artifacts. It does not use a
checked-in baseline that could be changed in the same pull request to hide a
breaking change.

The implemented format-2 comparison rejects removing a durable contract,
changing a stable workflow ID, decreasing `currentVersion`, removing a
previously accepted version, or changing or removing an existing schema
fingerprint. When a contract advances, the candidate must continue to accept the
previous current version. Format 1 remains a bootstrap input, and a candidate may
fill a previously `null` hash but may not contradict an existing claim.

The proposed format-3 comparison adds the canonical/write, encoder, rollback,
referential-integrity, and workflow result rules described above. Format-2
contracts normalize into format 3 with synthetic input contracts and legacy v0
result contracts; explicit definitions must preserve those identities and wire
formats. The manifest gate detects structural regressions only, so historical
fixtures, mixed-version scenarios, and suspended-session canaries provide the
behavioral checks below.

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

1. Move cross-deployment operations behind contract-owned facades and generate
   the deterministic manifest from their definitions.
2. Version the remaining stable workflow inputs and formalize driver capability
   negotiation.
3. Apply declared schemas, migrations, and frozen fixtures to every durable
   hook and state family.
4. Mechanically reject raw durable primitive imports outside the contract
   facades and historical fixtures.
5. Compare candidate manifests with supported production cohorts and run the
   mixed-version CI matrix.
6. Route latest turns through an explicit regression-gated deployment pointer
   with pre-promotion canaries.

## Non-goals

- Pinning existing agents to old authored code.
- Adopting Temporal patch markers or replaying candidate code inside old runs.
- Introducing a second binary serialization format; Workflow continues to own
  byte serialization.
- Claiming that a build-time schema check proves application-level semantic
  equivalence.
- Defining a public authoring API in the foundation manifest release.
