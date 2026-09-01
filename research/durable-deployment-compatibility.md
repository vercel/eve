---
issue: https://github.com/vercel/eve/issues/1765
status: proposed
last_updated: "2026-09-01"
---

# Durable deployment compatibility

## Proposal

eve routes each new turn to the latest production deployment so active agents
adopt new instructions, tools, models, and framework behavior. The long-lived
session driver remains pinned to the deployment that created it, while each turn
is a fresh child workflow on the deployment selected when that turn starts.

That topology makes deployment compatibility a protocol owned by eve. An old
driver sends durable input and session state to a new turn, the new turn returns
state and control actions to the old driver, and a new producer can resume a hook
owned by old code. The producer and consumer compile independently, so a shared
TypeScript type does not define their wire contract.

```text
old pinned driver
    | serialized input and session state
    v
latest compatible turn
    | result, session state, and hook payloads
    v
old pinned driver
```

eve defines those boundaries through an internal TypeScript-embedded durable
contract DSL. One contract graph owns durable identities, versioned values,
migrations, target encoders, deployment affinity, generated runtime facades,
workflow bundling, and the build manifest. Raw workflow and persistence
primitives cannot create an unregistered cross-deployment boundary.

The DSL makes structural compatibility necessary but not sufficient. Its
compiler rejects identity, version, schema, graph, and ownership regressions.
Historical fixtures, mixed-version execution, and suspended-session canaries
check behavior that static declarations cannot prove. Production routes new
turns to the latest deployment that passes both layers, not merely the newest
deployment.

Workflow history replay is not the primary proof for this topology. The old
driver stays on its original deployment and the latest turn starts with fresh
workflow history; the risky boundary is the serialized protocol between those
runs.

## Contract DSL at a glance

The DSL has six boundary constructs and three orthogonal policy axes:

```text
Boundary  ::= Value | Workflow | Inbox | State | Stream | Opaque
Evolution ::= Migratable | Opaque
Encoding  ::= FixedWrite | TargetEncoded
Affinity  ::= CompatibleDeployment | OriginDeployment | RuntimeOwner(name)
```

| Construct          | Boundary owned                               | Generated behavior                                             |
| ------------------ | -------------------------------------------- | -------------------------------------------------------------- |
| `durable.value`    | One value interpreted by different code      | Validation, migration, encoding, schema identity               |
| `durable.workflow` | Cross-deployment workflow input and result   | Stable routing, branded starts, decoded results                |
| `durable.inbox`    | Hook, callback, or inbox payload             | Consumer negotiation, target encoding, parked failure          |
| `durable.state`    | Persisted framework state                    | Stable key, migrated reads, versioned writes                   |
| `durable.stream`   | Append-only events from multiple deployments | Per-event encoding, projection, explicit unknown-event policy  |
| `durable.opaque`   | Value eve cannot safely interpret            | Origin-deployment affinity or named external-runtime ownership |

Transport constructs compose `durable.value` contracts rather than defining
independent version systems. Codecs and migrations remain ordinary TypeScript
functions. Identities, versions, graph edges, and policies remain static data
that the compiler can inspect.

## Contract authoring experience

The turn workflow and adjacent durable boundaries form one contract program:

```ts title="packages/eve/src/execution/durable-contracts.ts"
const turnWorkflowInput = durable.value<TurnWorkflowInput>({
  name: "turnWorkflow.input",
  canonicalVersion: 1,
  writeVersion: 1,
  initialVersion: 0,
  versions: {
    0: { decode: decodeTurnWorkflowInputV0, schema: null },
    1: {
      decode: decodeTurnWorkflowInputV1,
      schema: durable.buildSchema(() => import("./turn-workflow-input-v1.schema.js")),
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

export const turnControl = durable.inbox({
  name: "turnControl",
  message: turnControlWire,
  negotiation: "consumer",
  targets: turnControlTargets,
  resolveTarget: resolveTurnControlTarget,
});

export const turnWorkflow = durable.workflow({
  name: "turnWorkflow",
  input: turnWorkflowInput,
  result: durable.void("turnWorkflow.result"),
  failure: {
    inbox: turnControl,
    legacyRoutes: {
      0: extractTurnWorkflowV0FailureRoute,
      1: extractTurnWorkflowV1FailureRoute,
    },
  },
  run: runTurnWorkflow,
});

export const sessionInbox = durable.inbox({
  name: "sessionInbox",
  message: sessionInboxWire,
  negotiation: "consumer",
  targets: {
    legacyDeliver: { version: 0, encode: encodeSessionInboxV0Deliver },
    legacySend: { version: 0, encode: encodeSessionInboxV0Send },
    v1: { version: 1, encode: encodeSessionInboxV1 },
  },
  resolveTarget: resolveSessionInboxTarget,
});

export const pendingAuthorization = durable.state({
  name: "pendingAuthorization",
  key: "eve.runtime.pendingAuthorization",
  value: pendingAuthorizationValue,
});

export const messageStream = durable.stream({
  name: "messageStream",
  protocol: messageStreamProtocol,
  event: messageStreamContract,
  unknownEvents: "ignore",
});

export const workflowContinuation = durable.opaque({
  name: "workflowContinuation",
  affinity: "origin-deployment",
});

export const workflowJournal = durable.opaque({
  name: "workflowJournal",
  affinity: durable.runtimeOwner("@workflow"),
});

await turnWorkflow.startLatest(input);
```

The DSL is internal to eve. It is not public agent authoring API. A declaration
returns branded producer and consumer surfaces; it does not expose the generic
workflow reference, raw state key access, or untyped hook resume path that would
allow callers to bypass the contract.

## Compilation and generated surfaces

The DSL program has several compilation targets:

```text
TypeScript durable contract graph
    |
    +-- branded producer and consumer facades
    +-- dependency-free workflow runtime descriptors
    +-- stable workflow bundler identities
    +-- durable-contract manifest and schema hashes
    +-- regression and migration obligations
    +-- historical fixture and cohort-test inventory
```

The TypeScript compiler checks composition and family brands. The workflow
transformer verifies top-level workflow bindings and removes build-only schema
references. The manifest compiler walks the same graph to emit deterministic
metadata. Runtime facades interpret codecs, migration, negotiation, and affinity.
No target maintains a parallel registry.

Literal contract names brand workflow and inbox handles, so two families are not
interchangeable even when their payload types match. Persisted metadata repeats
the contract identity because TypeScript brands do not survive serialization.

### Construction enforcement

Raw latest-start, hook, stream, state, attachment-reference, and opaque
continuation primitives remain internal to DSL-generated facades. A mechanical
import guard rejects their use from production modules, with narrow allowlists
for the facades, historical fixtures, and Workflow-runtime-owned journals.

The compiler rejects duplicate identities, missing version steps, missing target
encoders, unresolved graph edges, and workflow declarations that do not match
their DSL nodes. A function rename, removed workflow directive, changed routing
key, stale version declaration, or unregistered latest start fails before
release.

Construction proves that every eve-owned durable primitive has an explicit
owner and that contract metadata agrees across runtime, bundling, and the
manifest. It does not prove semantic equivalence of arbitrary JavaScript.

## Boundary ownership

A value needs an explicit owner when its producer and consumer may execute
different code, including when storage outlives the deployment that wrote it.
Values interpreted by eve use durable contracts. Values eve cannot migrate use
origin affinity or name the external runtime that owns interpretation.

| Boundary                                                         | Required owner                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| Workflow routed across deployments                               | Workflow plus input and result value contracts                    |
| Hook, callback, or inbox resumed by another deployment           | Inbox contract with consumer capability negotiation               |
| Session snapshot or framework state read after a deployment      | Value or state contract with forward migrations                   |
| Event stream containing records from multiple deployments        | Stream contract with per-event versions and projection            |
| Attachment or reference interpreted by different deployment code | Value contract                                                    |
| Opaque dependency continuation or executable closure             | Origin-deployment affinity or owned adapter with explicit version |
| In-memory value consumed entirely within one pinned execution    | No durable contract                                               |
| Workflow journal interpreted only by the Workflow runtime        | `durable.runtimeOwner("@workflow")`                               |

A numeric version does not make an executable or dependency-owned value safe to
migrate. When eve cannot define a deterministic data transformation, the
operation resumes on its originating deployment, is invalidated, or crosses an
explicit execution epoch. The graph records that decision instead of publishing
a compatibility claim eve cannot uphold.

## Value contracts

`durable.value` is the shared evolution primitive. Workflow input and result,
inbox messages, state cells, stream events, and durable references all compose
it.

```ts
interface DurableValueContract<TCurrent> {
  readonly acceptedVersions: readonly number[] | null;
  readonly canonicalVersion: number;
  readonly encodableVersions: readonly number[];
  readonly name: string;
  readonly schemaHashes: Readonly<Record<number, string | null>> | null;
  readonly writeVersion: number;
  decode(value: unknown): TCurrent;
  encode(value: TCurrent, targetVersion?: number): unknown;
}
```

`decode` parses the envelope, selects and validates the declared wire version,
applies forward migrations, validates the canonical representation, and returns
only that representation. An unsupported version or failed migration never
reaches application logic.

`encode` accepts the canonical domain value. Without a target it emits
`writeVersion`; target-encoded transports select one of `encodableVersions`.
Every encoder constructs its target wire shape directly from the canonical
value. It is not a general reverse migration over arbitrary persisted data.

### Version model

`canonicalVersion` identifies the representation delivered to consuming code.
`writeVersion` identifies the default representation emitted by producers.
Separating them allows a release to read N+1 while continuing to write N for
rollback safety.

`acceptedVersions` is the complete finite set current code can decode. A `null`
set means support has not yet been modeled, not that no versions or every
version is accepted. A legacy `null` contract may continue writing its existing
version, but it cannot advance that version.

`initialVersion: 0` identifies a historical unversioned shape. Each migration
moves exactly one version forward. Every accepted version must have a complete
path to `canonicalVersion`, and every advertised encodable version must have an
encoder.

A `null` accepted set becomes finite only in a reader-only release that preserves
the existing write version and adds executable fixtures for every claimed
historical cohort. The following release may advance the write version after the
finite reader declaration is part of the rollback floor.

### Schema identity

Each formalized version has one canonical schema identity. The build converts
the schema to JSON, recursively sorts object keys, and hashes the result with
SHA-256. A `null` hash means the version is recognized but has not yet adopted a
canonical schema; it does not permit changing a hash already published for that
version.

Schema imports are build-only. The workflow transformer emits a reduced runtime
descriptor containing version numbers, dependency-free decoders, encoders, and
migrations. Zod and `node:crypto` do not enter workflow bundles.

## Workflow contracts

`durable.workflow` binds one named top-level `"use workflow"` function to input
and result value contracts. A child whose parent waits on an inbox also declares
that terminal failure inbox. The compiler derives the immutable routing ID as
`workflow//eve//${name}` and verifies that the bundled declaration, graph node,
and manifest entry agree.

Every generated start carries its terminal route outside the application input,
so decode failure can reach the pinned caller before authored workflow code runs.
Each supported pre-DSL input version also declares a dependency-free legacy route
extractor. The extractor reads only the historical control token from the frozen
raw shape and sends the historical failure target when full input migration
cannot complete. A child workflow version cannot remain supported unless its
parent has either a generated terminal route, a legacy extractor, or direct raw
run monitoring.

The returned handle carries the literal contract name in a private TypeScript
brand. `startLatest` accepts only that handle and a canonical input value, never
a bare ID, generic workflow reference, or raw argument tuple. It encodes input at
the contract's write version before starting the hidden reference.

```ts
interface DurableRun<TResult> {
  readonly runId: string;
  readonly returnValue: Promise<TResult>;
}

interface DurableWorkflow<TName extends string, TInput, TResult> {
  readonly name: TName;
  readonly workflowId: string;
  startLatest(input: TInput, options?: DurableStartOptions): Promise<DurableRun<TResult>>;
}
```

The generated workflow entry decodes input before invoking the authored
function. It reports pre-run decode failure through the terminal inbox, using a
legacy route extractor when the caller predates the DSL. Generated callers also
race that inbox with raw run termination as a backstop. `DurableRun.returnValue`
decodes the persisted result before exposing it to the caller.

### Stable routing and deployment selection

`startLatest` preserves eve's environment-selection semantics. Production and
`eve dev` request latest; after the admission pointer lands, latest means the
latest regression-gated deployment rather than the newest deployment. Preview
starts remain on the deployment serving the request. A Workflow world that does
not implement latest routing falls back to the current deployment.

Compatibility tests and suspended-session canaries receive a separately
exported exact-start control. Its constructor rejects empty deployment IDs and
symbolic selectors such as `"latest"`, and its import is denied outside approved
test modules. Exact starts use the same input encoding and result decoding path.

### Workflow results

Every workflow declares a result contract. Workflows that communicate only
through hooks use `durable.void(name)`. Direct Workflow results have no receiver
capability negotiation, so their write version advances only when every
supported caller cohort accepts it. A result that requires per-consumer
negotiation travels through an inbox instead.

An existing workflow's historical raw return value becomes unversioned result
version 0. Its first result contract accepts v0, retains an encoder that
reproduces the raw shape, and continues writing v0 while a legacy caller can
remain. Frozen fixtures prove both bytes and domain semantics before the result
can move to a versioned envelope.

## Inbox contracts

`durable.inbox` binds a message value contract and named encoder targets to hook
ownership. Hook creation persists the inbox identity and accepted versions in
metadata. Resume inspects the exact target hook, resolves a declared target,
encodes, and resumes that same inspected hook object. Stamped consumers select
the highest target version supported by both sides.

`resolveTarget` is part of the inbox declaration. It receives a restricted hook
capability reader and may inspect related ownership, such as the stable session
hook used to classify markerless continuations. The compiler records its stable
identity and every target it may return; returning an undeclared target fails
before resume.

```text
producer encodable versions: [1, 2]
consumer accepted versions:  [0, 1]
selected wire version:       1
```

No compatible target fails explicitly and leaves the inbox parked. The producer
receives a structured error and retains responsibility for retry; the payload is
never reinterpreted as an unversioned legacy command.

Markerless historical hooks require a frozen classifier until their cohorts can
no longer exist. The current session inbox maps pre-stamp stable inbox consumers
to the `legacySend` target and older continuation consumers to
`legacyDeliver`. Both targets carry version 0 but have distinct encoders. The
classification tests concrete hook ownership rather than guessing from package
or deployment metadata.

Connection authorization callbacks use the same inbox contract. The callback
route negotiates before encoding, and authorization decodes before interpreting
the payload. An unknown version leaves the authorization challenge pending.

## State contracts

`durable.state` binds a stable persisted key to one value contract. Its reader
decodes and migrates historical values. Its writer emits the declared write
version. The state key is manifest identity and cannot change in place.

Framework modules cannot access a DSL-owned key through the raw
`Record<string, unknown>` session state. Import and source guards reserve raw
state access for the generated state facade and historical fixtures, preventing
an unversioned side channel around the contract graph.

This foundation covers eve-owned state. A public migration surface for authored
`defineState` values is a separate API decision.

## Stream contracts

`durable.stream` composes separate protocol and event value contracts. The
protocol contract versions framing and response-level behavior; the event
contract versions each persisted record. One append-only stream can contain
events written by many deployments, so a response header containing only the
newest protocol version cannot identify every historical record's shape.

The append facade encodes each event. The projector decodes or upcasts each
event independently. The declaration records whether an unknown event kind is
ignored, surfaced as an opaque event, or treated as terminal; changing that
policy is a manifest regression.

The existing `messageStream` format-2 entry remains the protocol value contract,
currently at version 23 on this branch. The new stream node references it; the
number does not become event version 23. Historical markerless events enter a
separate `messageStream.event` value contract as version 0. New events acquire
per-event versions only after readers accept the explicit discriminator. The
normal value compatibility rules independently govern protocol and event
evolution.

## Opaque contracts

`durable.opaque` declares a value that eve cannot safely interpret or migrate.
`affinity: "origin-deployment"` persists the producing deployment and allows
only that deployment to resume the operation. It is the default for executable
closures and dependency continuations that have no eve-owned data contract.

`affinity: durable.runtimeOwner(name)` records a stable external owner. For
example, `durable.runtimeOwner("@workflow")` leaves step journals and replay
records exclusively owned by the Workflow runtime. eve does not duplicate their
schema or claim compatibility for them.

Changing affinity or external owner identity is a graph regression. Moving an
opaque value to a migratable contract requires an explicit new boundary and
historical adapter; adding a version number to the existing opaque record is not
sufficient.

## Compiled manifest

Every eve build emits `dist/durable-contract-manifest.json` from the contract
graph. The artifact is lexically sorted and excludes timestamps, absolute paths,
Git revisions, and deployment-local values, so identical package inputs produce
identical bytes.

| Node     | Manifest identity and policy                                      |
| -------- | ----------------------------------------------------------------- |
| Value    | accepted, canonical, write, and encodable versions; schema hashes |
| Workflow | stable ID; input, result, and terminal failure edges              |
| Inbox    | message edge; named encoder targets; classifier and negotiation   |
| State    | persisted state key; value edge                                   |
| Stream   | protocol and event value edges; unknown-event policy              |
| Opaque   | origin-deployment affinity or named runtime owner                 |

The manifest validates every graph edge. Removing a node, changing its kind or
identity, retargeting an edge, or changing a state key, negotiation mode, stream
policy, or affinity in place is a regression.

### Format 2 transition

Format 2 is the bootstrap inventory emitted by the current branch. Existing
value contracts retain their identities and version history when normalized into
the graph. `sessionInboxWire` remains the value referenced by the new inbox node.

`messageStream` is the exception because its format-2 number describes the HTTP
stream protocol, not individual events. It remains a value contract and the new
stream node references it as `protocol`. A new `messageStream.event` value
contract starts at markerless version 0 and uses historical event-shape fixtures;
format 2 does not pretend old events carried the stream header as a discriminator.

Inline workflow input fields normalize to a synthetic
`${workflow.name}.input` value. Historical raw workflow results normalize to
`${workflow.name}.result` at unversioned version 0. The first explicit result
contract preserves that identity, accepts and encodes v0, and writes v0 while
legacy callers remain.

A format-2 contract with `acceptedVersions: null` retains unknown support. Its
current version is the only proven encodable and writable version. A candidate
may replace `null` with a finite accepted set only in a reader-only release that
preserves the write version and adds executable fixtures for every claimed
historical cohort. Unknown support never authorizes a write advance.

Format 1 remains accepted only as the initial manifest bootstrap. Existing
non-null schema hashes and compatibility claims cannot be removed when formats
advance.

## Compatibility rules

For base build B, candidate C, producer P, consumer R, and every supported
production cohort H, the graph compiler enforces:

```text
forward read:       H.writeVersion in C.acceptedVersions for every supported H
rollback read:      C.writeVersion in H.acceptedVersions
target negotiation: choose max(P.encodableVersions intersect R.acceptedVersions)
legacy target:      classifier selects one declared target identity
migration closure:  every accepted version reaches canonicalVersion
write validity:     writeVersion in encodableVersions
read preservation:  B.acceptedVersions subset C.acceptedVersions
write preservation: B.encodableVersions subset C.encodableVersions
version monotonic:  C canonical and write versions do not decrease
schema stability:   C.schemaHash[v] = B.schemaHash[v] for every frozen v
graph stability:    persisted names, edges, and policies do not change
origin affinity:    consumer deployment = origin deployment
runtime ownership:  only the declared external owner interprets the value
```

Membership, migration closure, and set preservation require finite accepted
sets. A legacy `null`-to-`null` comparison passes only when versions, schema
status, identity, and graph edges remain unchanged. A `null` set becomes finite
only through the reader-only fixture rule above.

Capability negotiation chooses a representable wire shape. It never authorizes
new behavior absent from the consumer's declared capabilities. New control
actions remain gated separately from payload encoding.

### Reader-first rollout

A new durable value version rolls out in two releases:

1. The reader release adds the new decoder, schema, migration, and target
   encoder, advances the canonical version, and continues writing the old
   version.
2. After that release becomes the rollback floor and passes historical cohorts,
   the writer release advances `writeVersion`.

Encoding the old wire version from the new canonical value is a target serializer,
not a reverse migration over stored history. The gate requires every supported
rollback cohort to accept the proposed write version before promotion.

## Runtime lifecycle

### Workflow input and result

The generated workflow facade owns the complete input and result path:

```text
canonical producer input
    | encode at input.writeVersion
    v
versioned persisted input
    | decode, validate, migrate, validate canonical
    v
run canonical workflow function
    | encode at result.writeVersion
    v
versioned or legacy-v0 result
    | DurableRun decodes
    v
canonical caller result
```

Decode failure occurs before the workflow function runs. Result decoding occurs
before the caller receives a value. Existing raw results remain v0 until legacy
callers can no longer exist.

### Target-encoded inbox delivery

The inbox facade negotiates against the pinned receiver before persistence:

```text
domain message
    | inspect exact hook metadata
    | select producer encodable intersect consumer accepted
    | encode selected version
    v
resume the inspected hook
    | consumer decode and migrate
    v
canonical inbox message
```

The selected hook object, not only its token, is passed to resume so an encoding
decision cannot be applied to a later hook that reused the token.

## Replay and failures

Workflow replay reuses committed facade results. Decoders, encoders, and
migrations are deterministic and side-effect free; externally visible work
remains inside ordinary durable steps. Target classifiers are side-effect free
but may inspect mutable hook ownership. A committed classification replays its
recorded target; an uncommitted retry inspects the exact current hook again and
may select a different declared target without applying an earlier decision to a
reused token.

Failure behavior follows the boundary that detects incompatibility:

- Workflow input skew fails before application logic executes. The generated
  terminal route reports it to the pinned parent, and caller-side raw run
  monitoring prevents a missing route delivery from leaving the parent parked.
- Inbox negotiation failure leaves the consumer parked and returns a structured
  error to the producer, which retains responsibility for retry.
- Inbox decode failure does not reinterpret the payload as a legacy shape.
- State decode failure fails the operation reading that state; it never replaces
  the value with defaults.
- Stream projection follows the declaration's explicit unknown-event policy.
- Origin-affinity mismatch fails before executing the opaque continuation.
- Runtime-owned values are never decoded by eve.

## Admission pipeline

No static declaration can prove the semantics of arbitrary migration or
application code. A deployment becomes latest only after structural and
behavioral admission:

```text
candidate build
    |
    +-- base/candidate graph regression
    +-- historical payload and result fixtures
    +-- mixed-version continuation scenarios
    +-- suspended-session production canary
             |
             v
    regression-gated latest
```

### Manifest regression

CI builds both the pull request base and candidate manifests. It does not compare
against an editable checked-in baseline that the same pull request could change
to hide a regression.

The comparator rejects contract removal, stable ID changes, version decreases,
accepted or encodable version removal, frozen schema changes, unresolved or
retargeted edges, and persisted policy changes. It applies forward-read and
rollback-read checks to every supported production cohort, not only the pull
request base.

### Historical fixtures and mixed-version cohorts

Frozen payload fixtures prove every declared version still decodes and every
target encoder emits the promised shape. Historical executable producers and
consumers prove domain behavior, fixed-point migration, rollback reads, and
preservation of declared durable keys.

The first required mixed-version cohort independently builds the published
eve 0.30.8 handler and the candidate handler against one promotable local
Workflow world. It proves the old session driver remains deployment-affine while
its next turn runs on the promoted candidate. Additional cohorts represent
distinct shipped protocol behavior, not every package release.

The suspension matrix covers parked and active turns, cancellation, runtime
actions, authorization, input requests, subagents, tasks, timeouts, state reads,
and workflow results.

### Promotion and demotion

Production latest resolves to the newest regression-gated deployment. Promotion
is not long-lived blue/green routing: after admission, each new turn takes the
promoted code. A demotion control restores the previous admitted deployment if a
semantic regression escapes canaries.

Older immutable drivers already call Vercel's existing
`resolve-latest-deployment` path. An eve-only resolver can protect newly created
drivers but cannot retrofit those runs. Complete demotion requires the platform
resolver to return an audited regression-gated deployment.

## Compatibility horizon

The default session lifetime is 30 days, but `sessionTimeoutMs: false` permits an
unbounded session. Compatibility does not expire merely because the default
timeout elapsed.

Until eve enforces a maximum session lifetime or rotates every durable owner,
shipped decoders, target encoders, and migrations remain permanent. Removing a
historical contract requires a product-level maximum window or an explicit
operation that migrates or terminates every session that can still produce or
consume it.

## Design invariants

- The DSL graph is the sole composition root for generated runtime facades,
  stable workflow identities, manifest output, and regression obligations.
- Every eve-owned cross-deployment boundary has a value contract or explicit
  opaque affinity declaration.
- Contract identities, graph edges, state keys, and persisted policies never
  change in place.
- Every accepted version validates and reaches the canonical version.
- Every write version has an encoder and is accepted by every required rollback
  cohort.
- New wire versions follow reader-first rollout.
- Unknown versions fail without consuming, defaulting, or reinterpreting durable
  data.
- Workflow inputs and results cross only through generated facades.
- Inbox delivery negotiates against the pinned consumer before persistence.
- Framework state and stream access cannot bypass generated facades.
- Build-only schemas never enter runtime workflow bundles.
- Opaque values execute only under their declared affinity or external owner.
- The manifest is deterministic compiled output from the graph used by runtime
  and bundling.
- Static compatibility is necessary but not sufficient; behavioral cohorts and
  suspended-session canaries remain admission requirements.

## Non-goals

- Pinning a session to old authored code for its full lifetime.
- Claiming schema equality proves semantic equivalence of migrations, tools, or
  application behavior.
- Replaying candidate code inside old workflow histories as the primary
  compatibility proof.
- Introducing a second binary serialization format; Workflow continues to own
  byte serialization.
- Introducing standalone DSL syntax, a parser, or code generation outside the
  TypeScript-embedded contract language.
- Making the internal foundation DSL a public agent-authoring API.
- Automatically migrating executable closures or opaque dependency state.
- Removing historical support while sessions can be unbounded.

## Implementation boundary

The current branch supplies the bootstrap pieces: stable workflow IDs, version-1
inputs for the stable workflow entrypoints, the target-aware session inbox,
versioned authorization callbacks, a deterministic format-2 manifest,
base-versus-candidate regression comparison, and the first mixed-version local
cohort. The source-controlled registry remains a bootstrap inventory; it does
not make raw boundary construction impossible.

The task input currently writes both `taskInboxToken` and its historical name,
`continuationToken`, so a new producer can start an older task workflow during a
deployment transition. Its v0 migration accepts either name. This bridge remains
until the historical target cohort cannot exist.

Turn-control producer gating follows the fail-loud decoder and terminal skew
path in #2625. It should land after that work rather than duplicating its workflow
bundle changes.

Implementation proceeds in six independently reviewable slices:

1. Introduce `durable.value`, `durable.inbox`, and `durable.workflow`; migrate
   the turn-control terminal edge, move stable latest starts behind generated
   facades, and compile complete workflow graph edges.
2. Migrate the remaining session, authorization, task, and subagent inbox
   families.
3. Introduce `durable.state`, `durable.stream`, and `durable.opaque`; migrate
   eve-owned session state, message events, references, and external-runtime
   ownership declarations.
4. Emit the format-3 graph manifest, normalize formats 1 and 2, and enforce the
   compatibility algebra against the base and supported cohorts.
5. Close raw primitive imports and run the complete historical fixture and
   mixed-version suspension matrix.
6. Route Vercel latest through an audited promotion pointer with immediate
   demotion and pre-promotion canaries.

Each slice preserves the current format-2 gate until its graph replacement is
active. No slice removes a historical decoder, encoder, or migration.

## Primary references

- [Versioned session inbox proposal](./session-inbox-wire-schema.md)
- [Durable migration chain](../packages/eve/src/execution/durable-session-migrations/chain.ts)
- [Latest workflow routing](../packages/eve/src/execution/workflow-runtime.ts)
- [Turn workflow input migration](../packages/eve/src/execution/durable-session-migrations/turn-workflow.ts)
- [Session inbox wire contract](../packages/eve/src/execution/wire/session-inbox-contract.ts)
- [Durable session store](../packages/eve/src/execution/durable-session-store.ts)
- [Compatibility issue #1765](https://github.com/vercel/eve/issues/1765)

## Review checklist

The proposal resolves the architectural review questions as follows:

- [x] **Make the DSL graph the only boundary authority.** Runtime facades,
      workflow identities, manifest output, and regression obligations compile
      from the same graph, with no manually synchronized registry.
- [x] **Close raw durable primitive bypasses.** Mechanical guards cover latest
      starts, hooks, state, streams, attachment references, and opaque
      continuations, with narrow historical-fixture and runtime-owner allowlists.
- [x] **Preserve forward and rollback reads.** Reader-first rollout and cohort
      comparison prove every proposed write version is readable by current and
      rollback deployments.
- [x] **Preserve historical workflow results.** Existing raw results become
      explicit v0 contracts with byte- and semantics-preserving fixtures.
- [x] **Normalize bootstrap manifests conservatively.** Format-2 identities and
      unknown support sets remain intact; normalization never invents support or
      authorizes a write advance.
- [x] **Prove target-encoded delivery.** Inbox negotiation selects only a common
      producer/consumer version and leaves the durable owner recoverable when no
      version exists.
- [x] **Keep platform routing limits explicit.** The design does not claim an
      eve-only resolver can demote old immutable drivers already using the
      platform's latest resolver.
- [x] **Require behavioral admission.** Generated manifests prove structure;
      historical mixed-version execution and suspended-session canaries remain
      the semantic merge and promotion gate.
