---
issue: https://github.com/vercel/eve/issues/1765
status: proposed
last_updated: "2026-08-07"
---

# Versioned wire schema for the session inbox

## Purpose

Payloads resumed into session inbox hooks outlive the deployment that wrote
them, but their shape is currently an emergent property of whatever TypeScript
type flows into `resumeHook`. A shared type is not a wire contract: both sides
recompile together while pinned deployments keep executing the old decode.
That gap produced two silent-loss incidents from one refactor (#1586 →
#1751): consumers on eve ≤0.30.2 dropped unknown payload kinds without a
trace, and consumers on 0.30.3–0.30.8 miscast them into empty deliveries.

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

// Stable encoder facade selects the current version.
encodeSessionCommand(input) // delegates to encodeSessionCommandV1

// Workflow-safe decoder: execution/wire/session-inbox-wire.ts
import type { SessionInboxWireV1 } from "./session-inbox-wire.v1.js";
export class SessionInboxWireError extends Error { ... }
const sessionInboxMigrations: readonly VersionMigration[] = [{ from: 0, to: 1, migrate }];
decodeSessionInbox(value) // runMigrationChain (initialVersion: 0) → version/kind → trust → normalize
```

Normative rules:

- **The current version has exactly one declared shape.** Changing it
  **must** be a new version: bump the constant, add a one-step
  `VersionMigration`, freeze the new shape. Historic versions live on as
  executable migrations plus frozen payload fixtures (the turn-workflow
  precedent), not as retained schemas.
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
- Per family, the `encode*` function **must** be the only producer of
  persisted payloads and `decode*` the only consumer-side interpretation.

## Version signals and their semantics

Two complementary signals, each covering the other's blind side:

```text
producer ──getHookByToken──▶ hook.metadata.eveVersion   (what can they decode?)
producer ──resumeHook──────▶ { v: N, ... }              (what did I send?)
consumer ──decode──────────▶ known v → typed payload
                             unknown v → loud failure, session stays alive
```

- **Envelope `v` (consumer-facing).** Every versioned payload carries `v`.
  Decode of an unrecognized `v` **must not** fall through to any legacy
  interpretation: it raises `SessionInboxWireError`, which the driver
  surfaces through a recorded reporting step (a durable trace in the run's
  event log plus a structured error log — the driver body cannot log
  directly, since logging pulls Node builtins the workflow bundle rejects),
  then keeps the session parked. A lost delivery with an operator-visible
  signal is the designed failure; a reinterpreted delivery is the bug this
  plan removes. A channel-visible error event **may** be added when the
  pattern generalizes beyond the session inbox.
- **Hook metadata stamp (producer-facing).** Consumers stamp
  `metadata: { eveVersion }` at `createHook` (part of this plan; the #1752
  mitigation deliberately shipped without it). When more
  than one emit-able version exists, the encoder maps the consumer's stamp to
  the newest wire version that eve release decodes; a markerless hook means
  the consumer predates the stamp and receives the legacy-compatible shape.
  The mapping lives in the wire module as data, not scattered conditionals.
- **Cost boundary.** Gating requires one `getHookByToken` before
  `resumeHook`. While only v1 exists the encoder emits v1 unconditionally and
  performs no pre-resume read; the read cost starts with the first release
  that emits two versions.

## Compatibility and payoff timeline

`v` is additive: every legacy cohort ignores unknown fields (≤0.30.2 reads
`payloads`, 0.30.3–0.30.8 reads `payload`, 0.30.9+ reads `payloads`), so v1
is byte-compatible with today's hybrid envelope and ships without gating.

| Phase                                               | Emit                                              | Removable                                                                      |
| --------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| Now                                                 | v1 (hybrid + `version: 1`) to everyone            | —                                                                              |
| Pre-stamp cohorts aged out (30-day session timeout) | v2 (no mirror) to stamped hooks; v1 to markerless | markerless branch soon after                                                   |
| Pre-version cohorts aged out                        | v2 only                                           | legacy unversioned decode paths, `SessionCommand` inbox fallback, mirror field |

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
- **Invariant guard (rule 39).** Outside `execution/wire/`, passing an
  inline session-wire payload literal to `resumeHook` is a violation unless
  it routes through a wire-module `encode*` function. Test files and
  `internal/testing/` frozen-consumer workflows are exempt — impersonating
  old cohorts is their job. The baseline starts at zero; baselines may only
  shrink.
- **Invariant guard (rule 40).** Every append-only
  `execution/wire/*-wire.vN.ts` module must have a colocated
  `*-wire.vN.test.ts`: v0 pins legacy fixtures and migration behavior; v1
  pins the complete schema, encoder, and round-trip. A version cannot ship
  as untested protocol history.
- Enforcement is layered by what each CI job can check: the mechanical
  guards (rules 39/40) run in the lint job and enforce presence and routing
  textually; the semantic contract (shape bytes, fixture decoding,
  round-trip) runs in the required unit tier, which executes the schemas.
  Both are required checks; neither can be skipped to merge.
- The existing e2e byte gate (`continuation-wire.eval.ts`) stays as the
  end-to-end backstop and asserts the current emitted version.

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
