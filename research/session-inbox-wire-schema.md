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

// Server/step-safe producers always select the current version.
sessionInboxWire.encode(input, { version: SESSION_INBOX_WIRE_VERSION })

// Workflow-safe decoder: execution/wire/session-inbox-wire.ts
import type { SessionInboxWireV1 } from "./session-inbox-wire.v1.js";
export class SessionInboxWireError extends Error { ... }
const sessionInboxMigrations: readonly VersionMigration[] = [{ from: 0, to: 1, migrate }];
sessionInboxWire.decode(value) // runMigrationChain (initialVersion: 0) → version/kind → trust → normalize
```

Normative rules:

- **The current version has exactly one declared shape.** Changing it
  **must** be a new version: bump the constant, add a one-step
  `VersionMigration`, freeze the new shape. Historic versions live on as
  executable migrations plus frozen payload fixtures (the turn-workflow
  precedent), not as retained schemas.
- **Protocol data and migration policy stay separate.** A `*.vN.ts` module
  owns the immutable schema and version-bound encoder. A
  `*.vN.migration.ts` module is a pure data transform with no normalization or
  version-selection dependencies. The encoder and decoder facades own mutable
  policy: emitting the current version, assembling the chain, and normalizing values
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
- **Encode goes through the wire module too.** Every persisted inbox
  payload — sends and controls alike — is built and validated against the
  current schema before it persists, so producer drift dies at the producer
  instead of at a pinned consumer weeks later.
- Per family, `sessionInboxWire.encode` **must** be the only producer of
  persisted payloads and `sessionInboxWire.decode` the only consumer-side
  interpretation.

## Version signals and their semantics

Producers validate and send the current inbox wire format directly by hook token.
The payload's `version` is the only version signal. Consumers retain the migration
chain for replaying older persisted payloads and reject unknown newer versions.

Inbox hooks carry no metadata. The removed `sessionInboxWireVersion` stamp had
one purpose: choosing an encoder for sessions pinned to older deployments. It
was written on the stable inbox, every channel alias (including replacements),
and the authorization callback. Workflow hydrates hook metadata during token
lookup, which requires resolving the run's encryption key even for an ordinary
resume. Omitting metadata removes that read-side key lookup from newly created
hooks.

`resumeSessionInbox` performs no capability lookup, historical consumer
classification, or fallback. It validates the current payload and calls
`resumeHook(token, payload)`, so Workflow owns token resolution and resume
idempotency. No replacement capability store or additional hook is needed.

## Compatibility

Sessions pinned to an older inbox wire format must be restarted when upgrading.
Deployment changes using the same inbox format continue to work. Already
persisted payloads still decode through the versioned migration chain; historical
schemas, encoders, and frozen fixtures remain as protocol history.

Removing the stamp does not erase metadata already persisted by older deployments.
Those hooks continue to incur Workflow's metadata hydration cost until they end.

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
  TypeScript requires an encoder for every registered wire version. The
  required unit tier then encodes and decodes every registry entry, while each
  version's frozen contract pins its exact shape and backwards migration.
- Rule 40 also freezes pure `*.vN.migration.ts` modules with their tests and
  rejects policy imports from those transforms. A one-time historical rewrite
  is represented by exact old/new Git blob hashes, so the exception expires as
  soon as the approved rewrite reaches `main`.
- Exact current-version bytes stay in the unit contract, where the encoded
  object can be asserted without decoding workflow-owned serde. The
  deterministic registry checks cover future wire-version changes. The
  agent-channels session-inbox redeploy eval verifies that a new deployment can
  deliver and cancel through an existing metadata-free inbox using the same
  wire format.

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
