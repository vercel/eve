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
migrations, parent-child dispatch, historical bridges, policy declarations,
generated runtime facades, workflow bundling, and the build manifest. Raw
workflow and persistence primitives cannot create an unregistered
cross-deployment boundary.

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

The DSL separates durable nodes, lifecycle relations, historical edges, and
policy declarations:

```text
Boundary ::= Value | Workflow | Inbox | State | Stream | Opaque
Relation ::= Settlement | Dispatch
History  ::= Bridge
Policy   ::= StreamUnknownPolicy | Affinity
```

| Construct                 | Owns                                                            |
| ------------------------- | --------------------------------------------------------------- |
| `durable.value`           | Validation, migration, current encoding, and schema identity    |
| `durable.workflow`        | Executable workflow identity, input, and result                 |
| `durable.inbox`           | Hook identity, current message encoding, and decode             |
| `durable.settlement`      | Exhaustive child-outcome adaptation into one parent inbox       |
| `durable.dispatch`        | Parent-child start, terminal route, monitoring, and settlement  |
| `durable.bridge`          | One named historical adaptation between branded graph endpoints |
| `durable.state`           | Persisted key, migrated reads, and current writes               |
| `durable.stream`          | Protocol, event projection, and referenced unknown-event policy |
| `durable.opaque`          | Value interpreted only under a referenced affinity declaration  |
| `durable.streamUnknown.*` | Named stream projection policy                                  |
| `durable.affinity.*`      | Named origin-deployment or external-runtime ownership           |

Transport constructs compose `durable.value` contracts rather than defining
independent version systems. Codecs and migrations remain ordinary TypeScript
functions. Identities, versions, graph edges, and policies remain static data
that the compiler can inspect.

## Contract authoring experience

The turn workflow and adjacent durable boundaries form one contract program:

```ts title="packages/eve/src/execution/durable-contracts.ts"
const turnWorkflowInputV0 = durable.legacy<TurnWorkflowInputV0>({
  decode: decodeTurnWorkflowInputV0,
});

const turnWorkflowInputV1 = turnWorkflowInputV0.next<TurnWorkflowInput>({
  decode: decodeTurnWorkflowInputV1,
  encode: encodeTurnWorkflowInputV1,
  migrate: turnWorkflowInputV0ToV1,
  schema: durable.buildSchema(() => import("./turn-workflow-input-v1.schema.js")),
});

const turnWorkflowInput = durable.value({
  name: "turnWorkflow.input",
  current: turnWorkflowInputV1,
});

async function runTurnWorkflow(input: TurnWorkflowInput): Promise<void> {
  "use workflow";
  await runTurn(input);
}

export const turnControl = durable.inbox({
  name: "turnControl",
  message: turnControlWire,
});

export const turnWorkflow = durable.workflow({
  name: "turnWorkflow",
  input: turnWorkflowInput,
  result: durable.void("turnWorkflow.result"),
  run: runTurnWorkflow,
});

export const turnSettlement = durable.settlement({
  name: "turnWorkflow.settlement",
  inbox: turnControl,
  adapt: settleTurnOutcome,
});

export const turnDispatch = durable.dispatch({
  name: "turnWorkflow.dispatch",
  child: turnWorkflow,
  settlement: turnSettlement,
});

export const turnWorkflowV0FailureRoute = durable.bridge({
  name: "turnWorkflow.dispatch.failure.v0",
  from: turnWorkflowInputV0.raw,
  to: turnDispatch.parentRoute,
  adapt: extractTurnWorkflowV0FailureRoute,
});

export const turnWorkflowV1FailureRoute = durable.bridge({
  name: "turnWorkflow.dispatch.failure.v1",
  from: turnWorkflowInputV1.raw,
  to: turnDispatch.parentRoute,
  adapt: extractTurnWorkflowV1FailureRoute,
});

export const sessionInbox = durable.inbox({
  name: "sessionInbox",
  message: sessionInboxWire,
});

export const sessionInboxLegacyDeliver = durable.bridge({
  name: "sessionInbox.legacyDeliver",
  from: sessionInbox.message,
  to: sessionInboxWireV0.wire,
  adapt: serializeAsV0Deliver,
  matches: isOlderContinuationConsumer,
});

export const sessionInboxLegacySend = durable.bridge({
  name: "sessionInbox.legacySend",
  from: sessionInbox.message,
  to: sessionInboxWireV0.wire,
  adapt: serializeAsV0Send,
  matches: isPreStampStableInboxConsumer,
});

export const pendingAuthorization = durable.state({
  name: "pendingAuthorization",
  key: "eve.runtime.pendingAuthorization",
  value: pendingAuthorizationValue,
});

export const messageStreamUnknownEvents = durable.streamUnknown.ignore({
  name: "messageStream.unknownEvents",
});

export const messageStream = durable.stream({
  name: "messageStream",
  protocol: messageStreamProtocol,
  event: messageStreamContract,
  unknown: messageStreamUnknownEvents,
});

export const workflowContinuationAffinity = durable.affinity.originDeployment({
  name: "workflowContinuation.affinity",
});

export const workflowContinuation = durable.opaque({
  name: "workflowContinuation",
  affinity: workflowContinuationAffinity,
});

export const workflowRuntimeOwner = durable.affinity.runtimeOwner({
  name: "workflowJournal.owner",
  owner: "@workflow",
});

export const workflowJournal = durable.opaque({
  name: "workflowJournal",
  affinity: workflowRuntimeOwner,
});

const parent = turnSettlement.receiver(turnControlHook);
await turnDispatch.startLatest(input, parent);
```

The DSL is internal to eve. It is not public agent authoring API. A declaration
returns branded producer and consumer surfaces; it does not expose the generic
workflow reference, raw state key access, or untyped hook resume path that would
allow callers to bypass the contract.

Version nodes and graph endpoints are reusable typed identities. Bridges connect
those identities without repeating version numbers or adding versions to the
value chain. The compiler derives each bridge's role from its endpoint brands.

## Compilation and generated surfaces

The DSL program has several compilation targets:

```text
TypeScript durable contract graph
    |
    +-- branded producer and consumer facades
    +-- dependency-free workflow runtime descriptors
    +-- dispatch settlement and bridge-selection plans
    +-- stable workflow bundler identities
    +-- durable-contract manifest and schema hashes
    +-- regression and migration obligations
    +-- historical fixture and cohort-test inventory
```

The TypeScript compiler checks composition and family brands. The workflow
transformer verifies top-level workflow bindings and removes build-only schema
references. The manifest compiler walks the same graph to emit deterministic
metadata. Runtime facades interpret value chains, dispatch settlement, bridge
selection, and referenced policy declarations. No target maintains a parallel
registry.

Literal contract names brand workflow and inbox handles, so two families are not
interchangeable even when their payload types match. Persisted metadata repeats
the contract identity because TypeScript brands do not survive serialization.

### Construction enforcement

Raw child starts, latest selection, hooks, streams, state, attachment references,
and opaque continuations remain internal to DSL-generated facades. A mechanical
import guard rejects their use from production modules, with narrow allowlists
for the facades, historical fixtures, and Workflow-runtime-owned journals.

The compiler rejects duplicate identities, missing version steps, missing bridge
adapters, unresolved graph edges, and workflow declarations that do not match
their DSL nodes. A function rename, removed workflow directive, changed routing
key, stale version declaration, or unregistered latest start fails before
release.

Every cross-deployment child start uses a dispatch. Every historical adaptation
outside a value's mainline migration chain uses a bridge whose source and target
belong to the same graph. Each supported pre-DSL child cohort must have exactly
one bridge to its dispatch's parent route unless the bootstrap manifest records
an audited raw-monitor-only exception.

Construction proves that every eve-owned durable primitive has an explicit
owner and that contract metadata agrees across runtime, bundling, and the
manifest. It does not prove semantic equivalence of arbitrary JavaScript.

## Boundary ownership

A value needs an explicit owner when its producer and consumer may execute
different code, including when storage outlives the deployment that wrote it.
Values interpreted by eve use durable contracts. Values eve cannot migrate use
origin affinity or name the external runtime that owns interpretation.

| Boundary                                                         | Required owner                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| Workflow routed across deployments                               | Workflow and input/result values                             |
| Parent waiting for a cross-deployment child                      | Dispatch relation                                            |
| Hook, callback, or inbox resumed by another deployment           | Inbox current path plus historical bridges                   |
| Session snapshot or framework state read after a deployment      | Value or state contract with forward migrations              |
| Event stream containing records from multiple deployments        | Stream contract with per-event versions and projection       |
| Attachment or reference interpreted by different deployment code | Value contract                                               |
| Historical or exceptional adaptation                             | Named bridge between branded graph endpoints                 |
| Opaque dependency continuation or executable closure             | Referenced affinity; migration only through named raw bridge |
| In-memory value consumed entirely within one pinned execution    | No durable contract                                          |
| Workflow journal interpreted only by the Workflow runtime        | Named `workflowRuntimeOwner` affinity declaration            |

A numeric version does not make an executable or dependency-owned value safe to
migrate. When eve cannot define a deterministic data transformation, the
operation resumes on its originating deployment, is invalidated, or crosses an
explicit execution epoch. The graph records that decision instead of publishing
a compatibility claim eve cannot uphold.

## Value contracts

`durable.value` is the shared evolution primitive. Workflow input and result,
inbox messages, state cells, stream events, and durable references all compose
it. Authors declare an append-only chain; the compiled facade exposes the
derived metadata and operations:

```ts
interface DurableValueContract<TCurrent> {
  readonly acceptedVersions: readonly number[] | null;
  readonly currentVersion: number;
  readonly name: string;
  readonly schemaHashes: Readonly<Record<number, string | null>> | null;
  decode(value: unknown): TCurrent;
  encodeCurrent(value: TCurrent): unknown;
}
```

`decode` parses the envelope, selects and validates the declared wire version,
applies forward migrations, validates the canonical representation, and returns
only that representation. An unsupported version or failed migration never
reaches application logic.

`encodeCurrent` accepts the canonical domain value and emits the current node's
wire shape. Older wire shapes are produced only by transport bridges, such as the
session-inbox v0 bridges or a task dispatch-input bridge. A bridge adapts the
current domain value directly to its target wire endpoint; it is not a reverse
migration over arbitrary persisted data.

### Version model

`durable.legacy` creates markerless version 0. A new contract without historical
data begins with `durable.version`, which creates version 1. Calling `.next`
appends exactly one version and derives its number from its predecessor. The new
node owns the decoder, current encoder, schema, and required migration from the
previous node; those declarations cannot drift into separate maps.

`durable.value({ current })` derives `currentVersion` from the current node,
`acceptedVersions` from its complete predecessor chain, and schema hashes from
their build-only schemas. It also proves every accepted node reaches current
through contiguous migrations. There is no separately authored version registry,
migration map, encoder map, or write version.

```ts
const valueV2 = valueV1.next({
  decode: decodeV2,
  encode: encodeV2,
  migrate: migrateV1ToV2,
  schema: durable.buildSchema(() => import("./value-v2.schema.js")),
});

const value = durable.value({ name: "value", current: valueV2 });
```

A published node's schema, encoded fixtures, and normalized historical fixtures
are immutable. An in-place change to any of those artifacts fails with an
instruction to append `.next(...)`. Decoder, encoder, or migration code may be
fixed under the same node only when every frozen input, output, and normalization
remains identical and a new fixture demonstrates the previously missing case.

Append `.next(...)` whenever the persisted wire shape or its canonical meaning
changes. Internal implementation changes that preserve both do not append a
node. New wire fields, removed fields, stricter interpretation, or different
normalization require `.next(...)`; behavior unsupported by an old consumer uses
capability negotiation rather than overloading a value version.

A defective historical decoder or migration is not repaired by editing its
published node or by running through the same broken path. A named bridge adds a
direct recovery edge from the affected historical node:

```ts
export const valueV0DirectRecovery = durable.bridge({
  name: "value.v0.raw-to-v2",
  from: valueV0.raw,
  to: valueV2.decoded,
  adapt(raw): ValueV2 {
    return recoverRawV0AsV2(decodeCorrectedRawV0(raw));
  },
});
```

The bridge decodes the original persisted bytes and bypasses defective
intermediate normalization. It is a new immutable graph edge with historical
fixtures, not a mutation of v0 or a new accepted version. Data already overwritten
after a lossy migration cannot be reconstructed and is reported as unrecoverable.

Decode path selection is deterministic. For a historical source node, the
compiler chooses the recovery bridge with the highest reachable target on the
current chain, then follows contiguous migrations to current. If no bridge
exists, it uses the contiguous path. Only one recovery bridge may exist for a
source-target pair, and the manifest records the selected path so changing it
requires new fixtures and graph review.

A bootstrap contract may expose `acceptedVersions: null` when its history has
not yet been modeled. Before appending `.next(...)`, the same candidate must
declare the historical chain and add executable fixtures for every claimed
cohort. Once finite, the chain remains append-only.

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
and result value contracts. The compiler derives the immutable routing ID as
`workflow//eve//${name}` and verifies that the bundled declaration, graph node,
and manifest entry agree.

The generated workflow entry decodes input before invoking the authored function
and encodes its result before returning. The workflow declaration does not own a
parent route, child monitoring, latest selection, or historical failure
extraction; those are properties of a dispatch relation.

```ts
interface DurableWorkflow<TName extends string, TInput, TResult> {
  readonly name: TName;
  readonly workflowId: string;
}
```

### Workflow results

Every workflow declares a result contract. Workflows that communicate only
through hooks use `durable.void(name)`. Direct Workflow results have no receiver
capability negotiation, so a result consumed by an older pinned caller does not
change shape. A result that must evolve across mixed versions travels through an
inbox instead.

An existing workflow's historical raw return value becomes unversioned result
version 0. Its first result contract accepts v0, retains an encoder that
reproduces the raw shape, and continues emitting v0 while a legacy caller can
remain. Frozen fixtures prove both bytes and domain semantics. Moving that
exchange to a versioned envelope requires a negotiated inbox boundary, not a
global result-version rollout.

## Settlement contracts

`durable.settlement` declares how the closed set of child outcomes enters one
parent inbox. Its adapter is exhaustive over completion, authored failure,
cancellation, infrastructure termination, and pre-run decode failure. The
adapter produces the inbox's current domain message; normal inbox encoding or
historical bridges then handle the pinned receiver's wire shape.

```ts
type DispatchOutcome<TResult> =
  | { readonly kind: "completed"; readonly result: TResult }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "cancelled" }
  | { readonly kind: "terminated"; readonly error: unknown }
  | { readonly kind: "input-rejected"; readonly error: unknown };

interface DurableSettlement<TResult, TParentMessage> {
  readonly name: string;
  receiver(hook: WorkflowHook): DurableSettlementReceiver<TParentMessage>;
}
```

The declaration owns the adapter identity and inbox edge. Adding an outcome to
the closed union fails every settlement adapter at compile time until it handles
that outcome. Dispatch never hard-codes a parent-specific message mapping.

## Dispatch contracts

`durable.dispatch` owns one parent-child lifecycle. It binds a child workflow to
one settlement declaration, adds the settlement receiver out of band to every
generated start, and monitors normal result, authored failure, cancellation,
infrastructure termination, and pre-run decode failure.

```ts
interface DurableRun<TResult> {
  readonly runId: string;
  readonly returnValue: Promise<TResult>;
}

interface DurableDispatch<TName extends string, TInput, TResult, TParentMessage> {
  readonly name: TName;
  readonly workflowId: string;
  startLatest(
    input: TInput,
    parent: DurableSettlementReceiver<TParentMessage>,
  ): Promise<DurableRun<TResult>>;
}
```

The branded settlement receiver prevents a raw hook or unrelated inbox from
being passed to the dispatch. The generated child reports outcomes through that
route, while the caller-side facade races route delivery with raw child
termination as a mandatory backstop. The settlement adapter converts the outcome
to the parent message, and `DurableRun.returnValue` decodes the result before
exposing it to the caller.

A pre-DSL caller does not carry the generated parent route. Each supported
historical input node therefore requires one bridge from its raw endpoint to the
dispatch's parent-route endpoint. The bridge extracts only the historical control
token and adapts terminal failure without running the defective or incompatible
input decoder. Format-2 input nodes create this bridge obligation during manifest
normalization.

The dispatch resolves the child deployment before encoding input. If that
deployment accepts the current node, the dispatch uses `encodeCurrent`; otherwise
it requires exactly one bridge from `Dispatch.input` to an accepted historical
wire node. No bridge or multiple same-rank bridges fail before the child starts.
This is how a current producer starts an older task workflow without a dual-write
field in the ordinary input contract.

### Stable routing and deployment selection

`startLatest` belongs to the dispatch, not the workflow. Production and
`eve dev` request latest; after the admission pointer lands, latest means the
latest regression-gated deployment rather than the newest deployment. Preview
starts remain on the deployment serving the request. A Workflow world that does
not implement latest routing falls back to the current deployment.

Compatibility tests and suspended-session canaries receive a separately
exported exact-dispatch control. Its constructor rejects empty deployment IDs and
symbolic selectors such as `"latest"`, and its import is denied outside approved
test modules. Exact dispatches use the same input, parent-route, monitoring, and
result path.

## Inbox contracts

`durable.inbox` binds a message value contract to hook ownership. Hook creation
persists the inbox identity and accepted versions in metadata. The ordinary path
encodes the current message node without configuration.

Historical delivery is discovered from bridges whose source is the inbox message
endpoint and whose target is an accepted historical wire node. A bridge adapter
projects the current domain message into that wire shape. Its optional matcher
receives a restricted hook capability reader and may inspect related ownership,
such as the stable session hook used to classify markerless continuations.

Resume inspects the exact target hook, prefers current encoding when supported,
then evaluates applicable bridges by highest target node. Exactly one bridge may
match at that rank. Zero matches returns a structured incompatibility; multiple
matches return an ambiguous-bridge error. Both leave the inbox parked. The same
inspected hook object is passed to resume so a bridge decision cannot be applied
to a later hook that reused the token.

```text
producer current version:   2
historical bridge versions: [0, 1]
consumer accepted versions: [0, 1]
selected path:              v1 bridge
```

Markerless historical hooks require a frozen classifier until their cohorts can
no longer exist. `sessionInboxLegacySend` matches pre-stamp stable inbox
consumers; `sessionInboxLegacyDeliver` matches older continuation consumers.
Both bridges target the same v0 node but have different adapters and matchers.
The classification tests concrete hook ownership rather than guessing from
package or deployment metadata.

Connection authorization callbacks use the same inbox contract. The callback
route negotiates before encoding, and authorization decodes before interpreting
the payload. An unknown version leaves the authorization challenge pending.

## Compatibility bridges

`durable.bridge` declares one immutable historical edge between branded graph
endpoints. Endpoint types determine its role; authors do not provide a `kind`
flag or insert it into a target, failure, or recovery map.

| Source endpoint  | Target endpoint        | Derived role                         |
| ---------------- | ---------------------- | ------------------------------------ |
| `Inbox.message`  | `ValueNode.wire`       | Historical inbox serialization       |
| `Dispatch.input` | `ValueNode.wire`       | Historical child-input serialization |
| `ValueNode.raw`  | `Dispatch.parentRoute` | Pre-DSL terminal-route extraction    |
| `ValueNode.raw`  | `ValueNode.decoded`    | Direct historical value recovery     |
| `Opaque.raw`     | `ValueNode.decoded`    | Explicit opaque ownership migration  |

Every bridge has a stable name, source, target, and adapter. Inbox bridges may
also have a matcher over the restricted receiver capability view;
dispatch-input bridges match the resolved child deployment's accepted input
nodes. Bridges do not add accepted value versions and cannot become the ordinary
current path.

The compiler rejects duplicate source-target recovery bridges and ambiguous
same-rank inbox matchers. Removing or retargeting a published bridge, changing
its adapter or matcher identity, or changing the selected recovery path creates a
graph regression and requires frozen fixtures.

## State contracts

`durable.state` binds a stable persisted key to one value contract. Its reader
decodes and migrates historical values. Its writer emits the current node. The
state key is manifest identity and cannot change in place.

Framework modules cannot access a DSL-owned key through the raw
`Record<string, unknown>` session state. Import and source guards reserve raw
state access for the generated state facade and historical fixtures, preventing
an unversioned side channel around the contract graph.

Every generated persistence facade writes the contract identity and actual
emitted node with the value: current for ordinary writes, or the selected wire
node for bridge delivery. Any record required to execute a session
updates the session's compatibility index in the same durable step result or
storage transaction; the record is not visible as committed unless the index is
committed with it. Latest routing and recovery compare that index with deployment
manifests before selecting code.

Output-only records, such as message-stream events, are excluded from execution
routing and carry their own contract node for projection by the current stream
reader. A record cannot use that exception if session execution may read it. A
deployment that cannot decode any indexed execution dependency is never selected
for that session.

This foundation covers eve-owned state. A public migration surface for authored
`defineState` values is a separate API decision.

## Stream contracts

`durable.stream` composes separate protocol and event value contracts. The
protocol contract versions framing and response-level behavior; the event
contract versions each persisted record. One append-only stream can contain
events written by many deployments, so a response header containing only the
newest protocol version cannot identify every historical record's shape.

The append facade encodes each event. The projector decodes or upcasts each
event independently. The stream references one named policy created by
`durable.streamUnknown.ignore`, `.surfaceOpaque`, or `.failProjection`. An
arbitrary string is not accepted. Replacing the policy edge or changing the
published policy declaration is a manifest regression.

The existing `messageStream` format-2 entry remains the protocol value contract,
currently at version 23 on this branch. The new stream node references it; the
number does not become event version 23. Historical markerless events enter a
separate `messageStream.event` value contract as version 0. New events acquire
per-event versions only after readers accept the explicit discriminator. The
normal value compatibility rules independently govern protocol and event
evolution.

## Opaque contracts

`durable.opaque` declares a value that eve cannot safely interpret or migrate.
It references a named affinity declaration rather than embedding a mode.
`durable.affinity.originDeployment` persists the producing deployment and allows
only that deployment to resume the operation. It is the normal declaration for
executable closures and dependency continuations that have no eve-owned data
contract.

`durable.affinity.runtimeOwner` records a stable external owner. The
`workflowRuntimeOwner` declaration leaves step journals and replay records
exclusively owned by `@workflow`; eve does not duplicate their schema or claim
compatibility for them.

Changing affinity or external owner identity is a graph regression. Moving an
opaque value to a migratable contract requires an explicit new boundary and
named bridge from `Opaque.raw` to the new value's decoded endpoint. The external
owner must expose the raw value to that bridge; otherwise migration is impossible.
Adding a version number to the existing opaque record is not sufficient.

## Compiled manifest

Every eve build emits `dist/durable-contract-manifest.json` from the contract
graph. The artifact is lexically sorted and excludes timestamps, absolute paths,
Git revisions, and deployment-local values, so identical package inputs produce
identical bytes.

| Node                  | Manifest identity and edges                                |
| --------------------- | ---------------------------------------------------------- |
| Value                 | current and accepted nodes; schema and migration edges     |
| Workflow              | stable workflow ID; input and result edges                 |
| Inbox                 | message edge and current wire endpoint                     |
| Settlement            | parent inbox, outcome adapter, and receiver endpoint       |
| Dispatch              | child, settlement, route, and monitoring endpoints         |
| Bridge                | source, target, adapter, matcher, and inferred role        |
| State                 | persisted state key and value edge                         |
| Stream                | protocol, event, and unknown-policy edges                  |
| Stream unknown policy | stable identity and projection behavior                    |
| Opaque                | affinity edge                                              |
| Affinity              | origin-deployment behavior or named external runtime owner |

The manifest validates every graph edge. Removing a node, changing its kind or
identity, retargeting an edge, or changing a state key, bridge adapter or matcher,
settlement adapter, dispatch relation, stream policy, or affinity in place is a
regression.

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
contract preserves that identity, accepts and encodes v0, and emits v0 while
legacy callers remain.

Each normalized pre-DSL child input node creates a graph obligation for one
bridge from its raw endpoint to the owning dispatch's parent route. A bootstrap
cohort may instead declare audited raw-run monitoring when that behavior already
exists historically; new authoring has no flag or escape hatch for it.

A format-2 contract with `acceptedVersions: null` retains unknown support. Its
current version is the only proven readable shape. A candidate that appends a
new node must replace `null` with a finite historical chain in the same build and
add executable fixtures for every claimed cohort. Unknown support never
authorizes a new current version by itself.

Format 1 remains accepted only as the initial manifest bootstrap. Existing
non-null schema hashes and compatibility claims cannot be removed when formats
advance.

## Compatibility rules

For base build B, candidate C, consumer R, and every supported historical cohort
H, the graph compiler enforces:

```text
historical read:    H.currentVersion in C.acceptedVersions for every supported H
bridge delivery:    current encoding or exactly one matching bridge is accepted by R
migration closure:  every accepted node reaches the current node
settlement closure: every dispatch outcome is adapted to the parent inbox
settlement stability: published inbox edge and adapter identity do not change
dispatch closure:   every supported child cohort has one parent settlement path
bridge stability:   published endpoints, adapter, and matcher do not change
bridge ambiguity:   no receiver cohort matches multiple same-rank inbox bridges
read preservation:  B.acceptedVersions subset C.acceptedVersions
version monotonic:  C.currentVersion >= B.currentVersion
schema stability:   C.schemaHash[v] = B.schemaHash[v] for every frozen v
graph stability:    persisted names, edges, and policies do not change
origin affinity:    consumer deployment = origin deployment
runtime ownership:  only the declared external owner interprets the value
```

Membership, migration closure, and set preservation require finite accepted
sets. A legacy `null`-to-`null` comparison passes only when versions, schema
status, identity, and graph edges remain unchanged. A candidate may replace
`null` and append a new current node in one build only when it declares and tests
the complete historical chain.

Capability negotiation chooses a representable wire shape. It never authorizes
new behavior absent from the consumer's declared capabilities. New control
actions remain gated separately from payload encoding.

### Single-deployment evolution

A durable shape change ships in one candidate deployment:

1. The author appends one `.next(...)` node containing the decoder, current
   encoder, schema, and migration from its predecessor.
2. The candidate proves it can read every historical cohort and becomes the new
   regression-gated latest deployment.
3. Latest-owned state writes the new current shape. A pinned driver may carry
   that state opaquely but cannot interpret or reconstruct it.
4. Messages and child starts sent to older pinned consumers use inbox or
   dispatch-input bridges targeting the historical nodes they understand.

This model does not promise arbitrary rollback after new state is written. A
deployment is a valid recovery target for a session only when its manifest
accepts every current value recorded in that session's compatibility index.
If no older admitted deployment satisfies that constraint, recovery rolls
forward. Inbox bridges preserve communication with old pinned consumers; they do
not make old application code a reader of new latest-owned state.

## Runtime lifecycle

### Workflow input and result

The generated dispatch and workflow facades own the complete input, settlement,
and result path:

```text
canonical producer input
    | dispatch resolves child deployment
    | input.encodeCurrent or historical dispatch-input bridge
    v
versioned persisted input
    | decode, validate, migrate, validate canonical
    v
run canonical workflow function
    | result.encodeCurrent
    v
versioned or legacy-v0 result
    | DurableRun decodes
    v
canonical caller result
```

Decode failure occurs before the workflow function runs. Result decoding occurs
before the caller receives a value. Existing raw results remain v0 until legacy
callers can no longer exist.

### Dispatch settlement

The dispatch converts every child terminal path into the closed outcome union and
passes it through the settlement declaration:

```text
child completion, failure, cancellation, termination, or input rejection
    | dispatch observes exactly one terminal outcome
    v
DispatchOutcome<TResult>
    | settlement adapter
    v
current parent-inbox message
    | current encoding or historical inbox bridge
    v
pinned parent receiver
```

The dispatch records terminal settlement before exposing `returnValue`. Replayed
monitoring reuses that result, so route delivery and raw child termination cannot
settle the parent twice.

### Inbox bridge delivery

The inbox facade negotiates against the pinned receiver before persistence:

```text
domain message
    | inspect exact hook metadata
    | use current encoding or select exactly one bridge
    | run the current encoder or bridge adapter
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
remains inside ordinary durable steps. Bridge matchers are side-effect free but
may inspect mutable hook ownership. A committed selection replays its bridge
identity; an uncommitted retry inspects the exact current hook again and may
select a different applicable bridge without applying an earlier decision to a
reused token.

Failure behavior follows the boundary that detects incompatibility:

- Workflow input skew fails before application logic executes. The dispatch's
  terminal route reports it to the pinned parent, and dispatch-owned raw run
  monitoring prevents a missing route delivery from leaving the parent parked.
- Inbox negotiation failure leaves the consumer parked and returns a structured
  error to the producer, which retains responsibility for retry.
- Inbox decode failure does not reinterpret the payload as a legacy shape.
- State decode failure fails the operation reading that state; it never replaces
  the value with defaults.
- Stream projection follows its referenced unknown-event policy declaration.
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

The comparator rejects contract, settlement, dispatch, or bridge removal; stable
ID changes; version decreases; accepted-version removal; frozen schema changes;
settlement adapter changes; unresolved or retargeted edges; ambiguous bridge
matching; and persisted policy changes. It proves the candidate reads the
current value written by every supported historical cohort, not only the pull
request base.

### Historical fixtures and mixed-version cohorts

Frozen payload fixtures prove every declared version still decodes and every
bridge adapter emits the promised shape. Fixtures pin both session-inbox v0
bridges, each pre-DSL dispatch route, direct-recovery inputs and outputs, matcher
cohort selection, and ambiguity rejection. Historical executable producers and
consumers prove domain behavior, fixed-point migration, bridge delivery, dispatch
settlement, and preservation of declared durable keys.

The first required mixed-version cohort independently builds the published
eve 0.30.8 handler and the candidate handler against one promotable local
Workflow world. It proves the old session driver remains deployment-affine while
its next turn runs on the promoted candidate. Additional cohorts represent
distinct shipped protocol behavior, not every package release.

The suspension matrix covers parked and active turns, cancellation, runtime
actions, authorization, input requests, subagents, tasks, timeouts, state reads,
and workflow results.

### Promotion and recovery

Production latest resolves to the newest regression-gated deployment. Promotion
is not long-lived blue/green routing: after admission, each new turn takes the
promoted code.

Recovery is compatibility-aware rather than a global rollback guarantee. A
previously admitted deployment may receive a session only when its manifest can
read that session's compatibility index. Sessions that have written newer
state remain on a compatible deployment and require a forward fix when no older
deployment qualifies.

Older immutable drivers already call Vercel's existing
`resolve-latest-deployment` path. An eve-only resolver can protect newly created
drivers but cannot retrofit those runs. Complete recovery routing requires the
platform resolver to select an audited deployment compatible with the session
compatibility index.

## Compatibility horizon

The default session lifetime is 30 days, but `sessionTimeoutMs: false` permits an
unbounded session. Compatibility does not expire merely because the default
timeout elapsed.

Until eve enforces a maximum session lifetime or rotates every durable owner,
shipped decoders, historical bridges, and migrations remain permanent. Removing a
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
- Value history is an append-only node chain; current, accepted, migration,
  schema, and current-encoder metadata are derived from that chain.
- Every accepted version validates and reaches the current canonical
  representation.
- Every current value node has an encoder, and every historical node has a
  migration path to current.
- New wire versions append one node and ship in one regression-gated deployment.
- Every child outcome is mapped through one exhaustive settlement declaration.
- Every cross-deployment parent-child lifecycle is owned by one dispatch.
- Every historical adaptation outside the mainline migration chain is a named
  bridge; bridges never add value versions or mutate the current path.
- Parallel inbox bridges classify historical consumers unambiguously.
- A session records a compatibility index, and routing never selects a
  deployment that cannot read it.
- Unknown versions fail without consuming, defaulting, or reinterpreting durable
  data.
- Cross-deployment child inputs, terminal outcomes, and results cross only
  through generated dispatch facades.
- Inbox delivery uses current encoding or exactly one bridge before persistence.
- Framework state and stream access cannot bypass generated facades.
- Build-only schemas never enter runtime workflow bundles.
- Stream behavior and opaque affinity are referenced declarations, not flags.
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
- Guaranteeing rollback to a deployment that cannot read state already written
  by the current deployment.

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

The DSL migration replaces that ad hoc dual-write with a named bridge from the
task dispatch input endpoint to the historical task-input wire node. The bridge
owns the `continuationToken` projection and its fixtures; ordinary current task
input contains only `taskInboxToken`.

Turn-control producer gating follows the fail-loud decoder and terminal skew
path in #2625. It should land after that work rather than duplicating its workflow
bundle changes.

Implementation proceeds in six independently reviewable slices:

1. Introduce `durable.value`, `durable.inbox`, `durable.workflow`,
   `durable.settlement`, `durable.dispatch`, and `durable.bridge`; migrate turn
   settlement and its two pre-DSL failure bridges, then move stable child starts
   behind dispatch facades.
2. Migrate session-inbox compatibility into the two named v0 bridges, then move
   authorization, task, and subagent inbox families.
3. Introduce `durable.state`, `durable.stream`, and `durable.opaque`; migrate
   eve-owned session state, message events, references, and external-runtime
   ownership declarations.
4. Emit the format-3 graph manifest, normalize formats 1 and 2, and enforce the
   compatibility algebra against the base and supported cohorts.
5. Close raw primitive imports and run the complete historical fixture and
   mixed-version suspension matrix.
6. Route Vercel latest through an audited promotion pointer with
   compatibility-index recovery and pre-promotion canaries.

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
      child starts, hooks, state, streams, attachment references, and opaque
      continuations, with narrow historical-fixture and runtime-owner allowlists.
- [x] **Derive version bookkeeping.** Authors append one `.next(...)` node;
      current, accepted, migration, schema, and encoder metadata compile from
      the chain; bridges cannot alter that bookkeeping.
- [x] **Make dispatch own parent-child settlement.** Starts, terminal routes,
      raw run monitoring, cancellation, and result delivery compose in one
      relation rather than workflow flags.
- [x] **Centralize historical adaptation.** Inbox projections, pre-DSL failure
      extraction, and direct recovery are named bridges between typed endpoints,
      never target, failure, or recovery maps.
- [x] **Preserve mixed-version communication.** The candidate reads every
      historical value, while inbox bridges serialize for old
      pinned consumers.
- [x] **Preserve historical workflow results.** Existing raw results become
      explicit v0 contracts with byte- and semantics-preserving fixtures.
- [x] **Normalize bootstrap manifests conservatively.** Format-2 identities and
      unknown support sets remain intact; normalization never invents support or
      authorizes a new current node without historical fixtures.
- [x] **Prove historical bridge delivery.** Inbox negotiation uses current
      encoding or exactly one applicable bridge and leaves the durable owner
      recoverable when neither path exists.
- [x] **Declare policy instead of passing flags.** Streams and opaque values
      reference named unknown-event and affinity declarations represented in the
      manifest.
- [x] **Keep platform routing limits explicit.** The design does not claim an
      eve-only resolver can reroute old immutable drivers or recover a session
      onto code that cannot read its compatibility index.
- [x] **Require behavioral admission.** Generated manifests prove structure;
      historical mixed-version execution and suspended-session canaries remain
      the semantic merge and promotion gate.
