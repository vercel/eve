---
issue: https://github.com/vercel/eve/issues/1765
status: proposed
last_updated: "2026-09-06"
---

# Versioned wire schema for the session inbox

## Purpose

Payloads resumed into session inbox hooks outlive the deployment that wrote
them, but their shape is currently an emergent property of whatever TypeScript
type flows into `resumeHook`. A shared type is not a wire contract: both sides
recompile together while pinned deployments keep executing the old decode.
That gap produced two silent-loss incidents from one refactor (#1586 →
#1751): consumers on eve ≤0.30.4 require the legacy `deliver` envelope,
while consumers on 0.30.5–0.31.0 require the raw `send` command during an
active turn.

This plan gives the session inbox a declared, versioned wire schema: one
module owns every shape that crosses the hook, encoding and decoding are the
only legal boundary operations, and an undecodable payload fails loudly
instead of being reinterpreted. Other durable hook payloads
(`turn-control`, subagent proxies, `runtime-action-result`) migrate in
follow-ups once this pattern is proven.

In this document, **must**, **should**, and **may** are normative.

## Authoring API

Production sends use `execution/session-inbox/encoder.ts`. It builds the current
wire representation, walks adjacent migrations backwards to the receiver's
version, validates the result against that version's frozen schema, and only
then returns a value that can be delivered.

Pure transformations live in `execution/session-inbox/migrations/`. Each entry
names two fixed versions. `Wire<V>` is inferred from the schema for version `V`;
adding a newer version does not change a historical migration's input type.

```ts
interface Migration<From extends Version, To extends Version> {
  readonly from: From;
  readonly to: To;
  up(payload: Wire<From>): Wire<To>;
  down(payload: Wire<To>): Wire<From>;
}
```

`down` throws `SessionInboxWireError` when there is no faithful translation.
An old receiver's inability to execute a requested operation is an error, never
permission to remove that operation and send the remainder.

For example, the v5→v6 entry handles session-owned task cancellation:

```ts
export const v5ToV6 = {
  from: 5,
  to: 6,
  up: (wire) => ({ ...wire, version: 6 }),
  down(wire) {
    if (wire.kind !== "cancel") return { ...wire, version: 5 };
    if (wire.tasks === true) {
      throw new SessionInboxWireError(
        "Cannot encode session-owned task cancellation for wire version 5.",
      );
    }
    const { tasks: _tasks, ...cancel } = wire;
    return { ...cancel, version: 5 };
  },
} satisfies Migration<5, 6>;
```

The static registry in `session-inbox/migrations.ts` assembles both directions:

```text
Read a v3 message:          v3 → v4 → v5 → v6 → normalize for the driver
Send a v6 command to v3:    v6 → v5 → v4 → v3 → validate v3 → deliver
```

### Compatibility decisions belong to the transition

| Transition | Upgrade                                                    | Downgrade                                                                                    |
| ---------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| v1 ↔ v2    | Adds the required payload mirror if absent.                | Removes optional caller activity-observer metadata.                                          |
| v2 ↔ v3    | Preserves the payload.                                     | Removes optional accepted-deployment metadata.                                               |
| v3 ↔ v4    | Converts executor input requests into typed answer routes. | Rejects agent and input requests; downgrading their execution protocol is unsupported.       |
| v4 ↔ v5    | Preserves the payload.                                     | Removes optional token cost from usage reports, retaining token counts and application data. |
| v5 ↔ v6    | Preserves the payload.                                     | Rejects session-owned task cancellation; ordinary cancellation survives.                     |

### Invariants

- **Historical contracts stay frozen.** Shipped schemas, snapshots, migration
  pairs, and their tests are append-only. Retained schemas validate downgrade
  outputs; fixtures preserve examples of actual historical data.
- **Every transition has a typed pair and a test.** The registry test requires
  one adjacent pair per supported transition and checks both directions against
  the frozen schemas. Semantic tests cover the operation-specific differences.
- **Validate after conversion.** The production encoder validates the current
  command and the final target value. Delivery helpers cannot bypass that
  contract, including the stable fast path and unversioned targets.
- **Keep pure transformations workflow-safe.** Migrations import schema types
  only. Zod stays on the producer side, outside the embedded workflow driver.
  CI checks the decoder, registry, legacy adapter, and migration imports.
- **Decoder trust remains explicit.** Known versioned messages are assumed to
  come from validated producers. The decoder checks version and discriminator
  and rejects known operation/version mismatches; it is not a complete second
  schema validator.
- **Legacy history is a separate adapter.** Unversioned data predates the
  contract and can include modern task fields emitted by historical writers.
  `session-inbox/legacy.ts` upgrades already-persisted values using the retained
  historical transforms. New sends to unversioned receivers must pass v1 first.
  The two old `send` and `deliver` envelopes remain explicit target variants.
- **The historical encoder is test-only.** `wire/session-inbox-encoder.ts` stays
  available to frozen tests, including those recording the original bug. CI
  forbids production imports; runtime callers use `session-inbox/encoder.ts`.

To add a version: freeze its schema and type, add its adjacent migration pair
and semantic test, register the pair and schema, and update the current wire
builder. Existing migration files do not change. CI checks continuity, schema
snapshots, migration output shapes, and rejection before hook delivery.

## Version signals and their semantics

Two complementary signals, each covering the other's blind side:

```text
producer ──getHookByToken──▶ hook.metadata.sessionInboxWireVersion
                                              (what can they decode?)
producer ──resumeHook──────▶ { version: N, ... }        (what did I send?)
consumer ──decode──────────▶ known version → typed payload
                             unknown version → loud failure, session stays alive
```

- **Envelope `version` (consumer-facing).** Every versioned payload carries
  `version`. Decode of an unrecognized `version` **must not** fall through to
  any legacy interpretation: it raises `SessionInboxWireError`, which the driver
  surfaces through a recorded reporting step (a durable trace in the run's
  event log plus a structured error log — the driver body cannot log
  directly, since logging pulls Node builtins the workflow bundle rejects),
  then keeps the session parked. A lost delivery with an operator-visible
  signal is the designed failure; a reinterpreted delivery is the bug this
  plan removes. A channel-visible error event **may** be added when the
  pattern generalizes beyond the session inbox.
- **Hook metadata stamp (producer-facing).** Consumers stamp
  `metadata: { sessionInboxWireVersion }` at `createHook`. The producer reads
  the capability marker and passes the resulting target to
  `sessionInboxWire.encode`.
- **Markerless historical classification.** Version 0 had two incompatible
  shapes. A markerless stable session inbox, or a markerless continuation hook
  whose run owns that stable inbox, receives raw `send`. That shape is required
  by eve 0.30.5–0.31.0 and remains accepted by later pre-stamp stable-inbox
  consumers. A markerless continuation without the stable inbox identifies eve
  ≤0.30.4 and receives legacy `deliver`. This tests a concrete historical
  capability rather than guessing from deployment or package metadata.
- **Saved receiver addresses.** The pinned driver advertises its canonical
  session ID and wire version in serialized context. Local subagent input
  requests save that address with their reply route. A later producer can
  encode for the original receiver without reading hook metadata, even if a
  newer deployment handles the reply or the continuation alias changes.
  Workflow-tool relays carry the stable inbox token in their existing reply
  field because input answers fit the unversioned `send` contract.
- **Cost boundary.** Saved receiver addresses and compatible commands to
  stable inbox tokens skip metadata negotiation and use token-based
  `resumeHook`, retaining Workflow's backend resume deduplication. Other
  producers read the target with `getHookByToken`. Markerless continuation
  hooks require one additional raw ownership lookup for the stable-inbox
  capability. For these negotiated sends, `resumeHook` receives the inspected
  hook object so the encoding decision cannot apply to a different hook that
  later reused the same token. Ownership-only reads use the raw world API;
  they do not need metadata hydration or an encryption-key lookup.

## Worked examples: choosing the delivery path

The fast path skips the metadata lookup only when the command fits the frozen
legacy contract. A stable token identifies the inbox; it does not advertise
which task operations the parent can execute.

These values match the examples in [the delivery tests][delivery-tests]:

```ts
const token = sessionCommandHookToken("session-1");
// "eve:session:session-1:inbox"

const message = { kind: "send" as const, payload: { message: "hello" } };
const agentRequest = {
  taskId: "task-1",
  replyTo: "agent-reply",
  request: {
    kind: "agent-invoke" as const,
    invocationId: "call-1",
    input: { message: "Find it", target: "research" },
  },
};
const workerCommand = {
  kind: "send" as const,
  payload: { task: { agentRequests: [agentRequest] } },
};
```

### Ordinary message: no metadata lookup

`resumeSessionInbox(token, message)` calls `encodeStableInboxCommand`.
The message fits the frozen payload schema and has no task operation or newer
caller fields. The encoder produces the unversioned command below, and
`resumeHook(token, wire)` performs the delivery. No model or agent tool runs
inside this delivery helper.

```ts
{ kind: "send", payload: { message: "hello" } }
```

The shown wire objects omit optional fields whose values are `undefined`.
Legacy input answers, such as
`{ kind: "send", payload: { inputResponses: [{ requestId: "question-1", text: "yes" }] } }`,
use the same path. Unknown payload fields and task envelopes leave the fast
path; they must be encoded for the selected receiver contract.

### Agent request: the receiver's version decides

`resumeSessionInbox(token, workerCommand)` cannot use the fast path because
`stablePayloadSchema` excludes `task`. It reads the hook with `getHookByToken`
and selects `hook.metadata.sessionInboxWireVersion`:

| Parent metadata                  | Encoder result                                          | Side effect                                                |
| -------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| `{ sessionInboxWireVersion: 3 }` | Rejects `task.agentRequests`: v3 has no such operation. | `resumeHook` is never called.                              |
| `{ sessionInboxWireVersion: 4 }` | Encodes a v4 `deliver` value containing the request.    | `resumeHook(hook, wire)` delivers it to that exact parent. |
| No version metadata              | Downgrades toward v1; v4→v3 rejects `agentRequests`.    | `resumeHook` is never called.                              |

For the v4 parent, the relevant fields are:

```ts
{
  kind: "deliver",
  version: 4,
  payload: workerCommand.payload,
  payloads: [workerCommand.payload],
}
```

Only after delivery does the parent's `routeDeliverToChildren` process
`task.agentRequests` and call `applyTaskAgentRequest` to dispatch the child.
For a rejected invocation, `wakeTaskAgentRequestParentStep` instead replies to
`"agent-reply"` with a `SESSION_INBOX_INCOMPATIBLE` dispatch error. The worker
can settle with that error instead of waiting for a child that was never started.

A saved address gives the same protection without a metadata lookup:
`resumeSessionInbox({ sessionId: "session-1", version: 4 }, workerCommand)`
encodes v4 directly. Changing that saved version to `3` rejects before delivery.

### The regression: validating a different payload from the one sent

[PR #2690][task-wire-regression] added a legacy-encoder exception that transformed
`workerCommand` in this order:

```text
Original payload:         { task: { agentRequests: [agentRequest] } }
Payload checked as v1:    { task: {} }
Payload put on the wire:  { task: { agentRequests: [agentRequest] } }
Envelope sent:           { kind: "send", payload: ... }  // no version
```

The v1 check passed because the new operation was temporarily removed. The
operation was then reinserted, and an old parent received a request it had no
handler for. The old handler removed the `task` envelope after processing the
fields it recognized, so no child agent was dispatched.

The historical codec and its frozen tests still describe that old encoding.
[The production encoder][production-encoder] rejects it while walking v4→v3,
including when called directly for an unversioned receiver. The complete target
value must pass the receiver's schema before `resumeHook` can execute.

[delivery-tests]: ../packages/eve/src/execution/wire/session-inbox-resume.test.ts
[production-encoder]: ../packages/eve/src/execution/session-inbox/encoder.ts
[delivery-boundary]: ../packages/eve/src/execution/wire/session-inbox-resume.ts
[task-wire-regression]: https://github.com/vercel/eve/blob/aae26311a845b5638f701311b742fab7d9cb4baf/packages/eve/src/execution/wire/session-inbox-encoder.ts#L76

## Compatibility and payoff timeline

Negotiated sends use the consumer's actual contract: markerless legacy
continuations receive unversioned `deliver`, markerless stable-inbox consumers
receive unversioned `send` (required by eve 0.30.5–0.31.0), and stamped
consumers receive their declared version. Commands that qualify for the stable
fast path keep the compatible unversioned `send` envelope.

| Phase                                               | Emit                                                        | Removable                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Now                                                 | v0 `deliver`, v0 `send`, or v1 according to the target hook | —                                                                              |
| Pre-stamp cohorts aged out (30-day session timeout) | current version to stamped hooks                            | markerless classifier and both v0 encoders                                     |
| Pre-version payloads aged out                       | current version only                                        | legacy unversioned decode paths, `SessionCommand` inbox fallback, mirror field |

Each removable row already has its condition written next to the code it
deletes; #1765 tracks the cleanups.

## Enforcement

Each family carries a frozen contract test with three checks, plus one
mechanical guard in the existing CI lint job (`pnpm guard:invariants`):

- **Frozen shape.** The complete current schema serializes to a byte-frozen
  JSON Schema snapshot. Editing any envelope or eve-owned payload field
  cannot pass this check — the only green path is bumping the version,
  adding a migration, and freezing the new schema artifact. The wire type is
  inferred from the same schema the encoder executes, so runtime validation
  and TypeScript cannot drift.
- **Backwards-compatibility fixtures.** Frozen payload JSON per shipped
  version **must** keep decoding on the current build, with frozen expected
  normalizations. This is the "current code still reads every payload ever
  persisted" invariant. Fixtures pin the pre-serde object; the devalue/zstd
  framing belongs to `@workflow` and is out of scope.
- **Round-trip.** `encode` output is byte-frozen, declares `currentVersion`,
  and decodes under the current schema — producers cannot drift from the
  schema they claim to emit.
- **Invariant guard (rule 40).** The explicit session-inbox version registry
  must be contiguous from v1, its highest entry must equal `currentVersion`,
  and its entries must exactly match the append-only
  `execution/wire/session-inbox-wire.vN.ts` modules. Every wire-version module
  must also have a colocated `*.test.ts`: v0 pins legacy fixtures and migration
  behavior; v1 pins the complete schema and encoder. A version cannot ship as
  unregistered or untested protocol history.
- Enforcement is layered by what each CI job can check. Rule 40 runs in the
  lint job and compares declared versions with shipped modules and tests.
  TypeScript requires an encoder for every registered stamped version. The
  required unit tier then encodes and decodes every registry entry, while each
  version's frozen contract pins its exact shape and backwards migration.
- Rule 40 also freezes pure `*.vN.migration.ts` modules with their tests and
  rejects policy imports from those transforms. A one-time historical rewrite
  is represented by exact old/new Git blob hashes, so the exception expires as
  soon as the approved rewrite reaches `main`.
- Exact current-version bytes stay in the unit contract, where the encoded
  object can be asserted without decoding workflow-owned serde. The
  deterministic registry checks cover future stamped-version changes. The
  agent-channels cross-version redeploy eval remains the end-to-end backstop
  for the pre-versioning gap: it runs the current producer against an actual
  eve@0.30.8 consumer.

## Alternatives considered

**Protobuf (or similar IDL codegen).** Rejected for this boundary. The byte
serialization is owned by `@workflow`'s serde (devalue + zstd) — eve hands it
JS objects — so protobuf would nest a second binary encoding inside a devalue
envelope and re-implement the semantics devalue already provides. Proto's
defining strengths (cross-language interop, compact bytes) do not apply to an
eve↔eve-only wire, and its default evolution posture — silently tolerating
unknown fields — is the exact failure mode this plan exists to eliminate.
Its real benefit, an externalized schema with mechanical evolution rules, is
what the frozen schema artifact provides without a second binary format or
codegen toolchain.

**A schema library in the workflow-safe decoder.** Tried and rejected on
measurement: importing vendored zod there grew `weather-agent` by +1.45 MB
and `zod/mini` by +1.63 MB because the driver bundle is self-contained,
contains inline `sourcesContent`, and is itself base64-embedded. The final
split keeps zod in the server/step-only encoder, where it is already bundled
and can express the complete transported type, while the decoder imports
only the inferred type and a dependency-free version constant.

## Non-goals

- Migrating the other `HookPayload` members, turn-control, or the turn inbox
  (follow-ups adopt the same module pattern).
- Changing the serde codec, hook APIs, or anything owned by `@workflow`.
- Any public authoring API: this is framework-internal wire discipline.
