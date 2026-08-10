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

No new framework: each wire family composes the repo's two existing
durable-format idioms. Version walking reuses `runMigrationChain`
(`execution/durable-session-migrations/chain.ts`), exactly as the durable
session snapshot and turn-workflow input already do; shape validation
reuses the compiled-artifact loader idiom (`version: z.literal(N)` schema +
`safeParse` + a named error class + `formatValidationError`). The session
inbox is the first family; turn-control, the subagent proxies, and the
auth-hook delivery adopt the same composition in follow-ups.

```ts
// One module per family, e.g. execution/wire/session-inbox-wire.ts
export const SESSION_INBOX_WIRE_VERSION = 1;
export class SessionInboxWireError extends Error { ... }

const sessionInboxWireSchema = z.discriminatedUnion("kind", [ ...current shapes,
  each with `version: z.literal(SESSION_INBOX_WIRE_VERSION)`... ]);
const sessionInboxMigrations: readonly VersionMigration[] = [{ from: 0, to: 1, migrate }];

decodeSessionInbox(value)   // runMigrationChain (initialVersion: 0) → safeParse → normalize
encodeSessionCommand(input) // build current shape → safeParse → persist
```

Normative rules:

- **The current version has exactly one declared shape.** Changing it
  **must** be a new version: bump the constant, add a one-step
  `VersionMigration`, freeze the new shape. Historic versions live on as
  executable migrations plus frozen payload fixtures (the turn-workflow
  precedent), not as retained schemas.
- **No schema library in the workflow body.** The shape is a declarative
  field table validated by a ~35-line walker. The driver bundle is
  self-contained (no external imports, no access to the server's shared
  `_libs` chunks) and is base64-embedded into the server bundle, with its
  own inline sourcemap carrying `sourcesContent` — so a vendored dependency
  costs roughly 5–6× its own size there. Measured on `weather-agent`:
  vendored zod added **+1.45 MB**, vendored `zod/mini` **+1.35 MB** (eve
  vendors a package as one pre-bundled artifact exposing its full API, which
  cannot tree-shake — proven by bundling the vendored file in isolation),
  and the field table **+0.04 MB**. The durable session snapshot store makes
  the same call for the same reason. Outside the workflow body, zod remains
  the right tool and is already bundled.
- **Version 0 is the unversioned era** (`initialVersion: 0`): every shape
  the family persisted before payloads carried `version`, following the
  field name every persisted eve structure already uses.
- **Decode validates, never trusts.** `runMigrationChain` rejects unknown
  newer versions ("written by a newer eve deployment") and the migration
  rejects unrecognized kinds; the migrated value is then parsed with the
  current schema. All failures throw the family's error class — a truncated
  or corrupted payload fails at the boundary, not three frames later.
- **Validation stops at the envelope.** Family-owned fields are asserted
  structurally and undeclared envelope keys are **stripped** (schemas use
  zod's default strip mode), so a caller-supplied field cannot ride onto the
  durable wire. Interiors owned by other subsystems (`DeliverPayload`,
  `auth`, `caller`) cross as opaque objects (`z.custom<T>`, object-ness
  only) and are never rewritten — deep-validating them would turn every
  adapter field addition into a wire change. Note what this does and does
  not promise: unrecognized **kinds** and malformed structure fail loudly,
  while additive envelope junk is silently discarded rather than rejected —
  discarding cannot lose declared data, and rejecting would risk dropping
  historic payloads.
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

| Phase                                               | Emit                                              | Removable                                                                 |
| --------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| Now                                                 | v1 (hybrid + `v: 1`) to everyone                  | —                                                                         |
| Pre-stamp cohorts aged out (30-day session timeout) | v2 (no mirror) to stamped hooks; v1 to markerless | markerless branch soon after                                              |
| Pre-`v` cohorts aged out                            | v2 only                                           | legacy no-`v` decode paths, `SessionCommand` inbox fallback, mirror field |

Each removable row already has its condition written next to the code it
deletes; #1765 tracks the cleanups.

## Enforcement

Each family carries a frozen contract test with three checks, plus one
mechanical guard in the existing CI lint job (`pnpm guard:invariants`):

- **Frozen shape.** The current version's schema serializes (via
  `z.toJSONSchema`, opaque interiors rendered as `{}`) to a byte-frozen
  string. Editing the shipped shape cannot pass this check — the only green
  path is bumping the version, adding a migration, and freezing the new
  shape. A vendored-zod upgrade that changes JSON-Schema emission can red
  this check without a wire change; the re-freeze protocol is to verify the
  diff is emission-only against the frozen payload fixtures (which must
  stay green untouched), then re-freeze the shape string.
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
- **Invariant guard (rule 40).** Every `execution/wire/*-wire.ts` family
  must have a colocated contract test containing `FROZEN_SHAPES` and
  `FROZEN_FIXTURES` — a family cannot ship without its frozen contract.
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
what the frozen JSON-Schema-per-version contract provides without a new
runtime dependency or codegen toolchain.

## Non-goals

- Migrating the other `HookPayload` members, turn-control, or the turn inbox
  (follow-ups adopt the same module pattern).
- Changing the serde codec, hook APIs, or anything owned by `@workflow`.
- Any public authoring API: this is framework-internal wire discipline.
