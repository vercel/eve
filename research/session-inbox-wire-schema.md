---
issue: https://github.com/vercel/eve/issues/1765
status: proposed
last_updated: "2026-09-04"
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

No new framework. Version walking reuses `runMigrationChain`
(`execution/durable-session-migrations/chain.ts`), exactly as the durable
session snapshot and turn-workflow input already do. The complete current
wire value is defined by one zod schema in a server/step-only encoder module;
the workflow-safe decoder imports only its inferred type. The session inbox
is the first family; turn-control, the subagent proxies, and the auth-hook
delivery adopt the same split in follow-ups.

```ts
// Dependency-free contract imported by encoder and decoder.
export const SESSION_INBOX_WIRE_VERSION = 1;
export type SessionInboxWireTarget =
  | { version: 0; variant: "deliver" | "send" }
  | { version: 1 };

// One append-only module per shipped version:
// execution/wire/session-inbox-wire.v1.ts (server/step only)
const deliverPayloadSchema = z.object({
  context: z.array(z.string()).optional(),
  inputResponses: z.array(inputResponseSchema).optional(),
  message: userContentSchema.optional(),
  outputSchema: jsonObjectSchema.optional(),
}).loose(); // explicit adapter extension point

export const sessionInboxWireV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deliver"), payloads: z.array(deliverPayloadSchema), ... }),
  ...controls,
]);
export type SessionInboxWireV1 = z.infer<typeof sessionInboxWireV1Schema>;
encodeSessionCommandV1(input) // build → parse complete value once → persist

// execution/wire/session-inbox-wire.v0.ts (dependency-free, temporary)
export const sessionInboxWireV0Migration: VersionMigration = { from: 0, to: 1, migrate };

// Server/step-safe encoder facade selects the target consumer's version.
sessionInboxWire.encode(input, target)

// Workflow-safe decoder: execution/wire/session-inbox-wire.ts
import type { SessionInboxWireV1 } from "./session-inbox-wire.v1.js";
export class SessionInboxWireError extends Error { ... }
const sessionInboxMigrations: readonly VersionMigration[] = [{ from: 0, to: 1, migrate }];
sessionInboxWire.decode(value) // runMigrationChain (initialVersion: 0) → version/kind → trust → normalize
```

Normative rules:

- **A versioned schema has exactly one declared shape.** Changing it
  **must** be a new version: bump the constant, add a one-step
  `VersionMigration`, freeze the new shape. The compatible delivery envelope
  does not advertise that sender-schema version. Historic versions live on as
  executable migrations plus frozen payload fixtures (the turn-workflow
  precedent), not as retained schemas.
- **Protocol data and migration policy stay separate.** A `*.vN.ts` module
  owns the immutable schema and version-bound encoder. A
  `*.vN.migration.ts` module is a pure data transform with no normalization or
  version-selection dependencies. The encoder and decoder facades own mutable
  policy: selecting a target, assembling the chain, and normalizing values
  received from another Workflow VM realm.
- **The complete transported value is validated once, at encode.** The
  schema owns the envelope and every eve-owned `DeliverPayload` field,
  composing the existing strict `inputResponseSchema` and
  `jsonObjectSchema`; adapter-specific payload fields are the explicit open
  extension point. The inferred schema type is the wire type, so runtime
  validation and TypeScript cannot drift.
- **Zod stays outside the workflow driver bundle.** Every producer is
  server-side or a `"use step"` body; in the driver bundle those steps are
  dependency-free stubs. The decoder imports `SessionInboxWire` with
  `import type` and the numeric version from a dependency-free contract
  module, so zod never enters the self-contained/base64-embedded driver.
- **Version 0 is the unversioned era** (`initialVersion: 0`): every shape
  the family persisted before payloads carried `version`, following the
  field name every persisted eve structure already uses.
- **Decode trusts a known current version because that trust is earned by
  the single encoder.** `runMigrationChain` rejects unknown newer versions;
  known v1 values were produced only by the schema-validating encoder. The
  decoder checks version and kind, then normalizes away wire-only fields.
  Legacy v0 is the temporary exception: those writers predate the encoder,
  so its 0→1 migration defensively checks the historic `send`/`deliver`
  fields until that cohort ages out under the 30-day timeout.
- **Encode goes through the wire module too.** Ordinary inbox payloads are
  validated against the current schema before their compatible envelope is
  built. Capability-dependent controls use the supported versioned encoder.
- Per family, the `sessionInboxWire` encoder facade **must** be the only producer of
  persisted payloads and `sessionInboxWire.decode` the only consumer-side
  interpretation.

## Stable delivery envelope and parent capabilities

Session drivers remain pinned while new turns and HTTP handlers use newer
code. Most inbox contents are forwarded to those turns. Adding an optional
field to a forwarded payload must not require restarting its parent session.

Ordinary sends and controls use `sessionInboxWire.encodeCompatible`. It
validates the complete value with the current sender schema, then emits the
unversioned envelope that shipped parents already decode. A delivery retains
its payloads, caller, delivery IDs, accepted deployment IDs, and routing
metadata. The historical stable-inbox cohort instead receives the compatible
raw `send` envelope with a coalesced payload.

```text
ordinary delivery → validate current contents → compatible envelope → pinned parent → turn
parent-owned control → inspect parent capability → supported encoder → pinned parent
```

The sender chooses the historical envelope without decrypting metadata:

- Stable session tokens receive raw `send` directly.
- An alias with a stored stamp belongs to the versioned-decoder cohort and
  receives unversioned `deliver`. Only the stamp's presence is inspected.
- An alias without metadata requires a raw lookup of its owner's stable
  hook. A stamped stable hook identifies a current parent (`deliver`); a
  markerless stable hook identifies the pre-stamp cohort (`send`). No stable
  hook identifies the oldest delivery-only cohort (`deliver`).
- A probed alias is resumed as the exact inspected hook, so a later reuse of
  its token cannot redirect the encoded delivery to another owner. Lookup or
  wake errors do not trigger a second delivery.

Only `cancel({ tasks: true })` requires metadata hydration and version
selection. That command changes behavior owned by the parent: an older parked
parent cannot enumerate and cancel its background tasks just because the next
turn runs newer code. Unsupported parents reject the operation before the
hook event is written, while ordinary delivery remains available.

The stable inbox and channel aliases retain `sessionInboxWireVersion: 6` for
already-deployed senders. Without it, those producers select the legacy v0
encoder, which drops caller observers and cannot encode task cancellation.
This compatibility stamp is fixed independently of future sender schemas.
Authorization callbacks store no metadata. There are no additional hooks or
replacement capability store. Ownership-only reads use raw hook records.

For example, the v6 schema adds optional `tasks` to cancellation; an ordinary
v6 message otherwise has the same shape as v5. A pinned v5 decoder rejects
that message solely because its envelope says `version: 6`. The compatible
envelope reaches that same decoder successfully, without weakening its
handling of previously persisted versioned values.

Future changes must distinguish forwarded contents from parent-owned
semantics. Adding forwarded fields requires compatibility tests against the
frozen historical receivers, including their migrations; removing a version
stamp alone does not prove preservation. A change to parent-owned routing or
control behavior needs an explicit capability strategy. Historical versioned
schemas, decoders, and migrations remain available for persisted payloads and
legacy producers.

## Cost boundary

Ordinary stable-ID deliveries need no explicit eve hook lookup. A stamped
alias needs one raw lookup; a markerless alias needs a second raw lookup of
the stable hook to distinguish historical receivers. None of these paths
hydrates metadata or resolves a read key. Task cancellation retains the
capability read. Workflow's underlying delivery lookup and payload encryption
remain unchanged; this does not claim that every transport round trip is
removed.

Authorization-hook creation no longer serializes metadata. Stable and channel
hooks, including rekeyed aliases, retain their compatibility stamp. Ordinary
producers read only the stamp's presence, including on existing persisted
hooks. Existing sessions do not need to be restarted.

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
