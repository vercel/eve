---
issue: "TBD (maintainer-requested implementation plan; no issue supplied)"
status: proposed
last_updated: "2026-09-23"
---

# Internal experiments over evals

## Goal and decisions

Refactor the experimental harness on `prha/eval-latency` into an internal tool for
comparing source revisions and model/reasoning configurations over existing evals.
An author supplies an experiment, including ordinary functions that derive metrics
from captured eval artifacts. No framework API is being proposed.

Decisions agreed during branch review:

- Remove profiles. They currently combine measurement, model aliases, source-diff
  policy, and fixture lifecycle responsibilities that should change independently.
- Keep `eve eval` as the sole execution engine. Preserve fixture setup, teardown,
  judges, timeouts, assertions, and strict correctness semantics.
- Cross source revisions with named runtime configurations. Support instruction
  changes across models, and model/reasoning changes at one source revision.
- Keep measurements pure and replayable from archived evidence. Derivation does
  not execute an eval, choose a baseline, or decide statistical eligibility.
- Use plain modules and small internal types, not `defineExperiment`,
  `defineMeasurements`, a registry, or a general plugin framework.
- Keep GitHub Actions as the live execution environment. Local planning, tests,
  extraction, and report regeneration are useful; do not enable or run live e2e
  suites locally contrary to repository policy.

Non-goals: a public `eve experiment` command, a second benchmark engine, arbitrary
matrix dimensions, a statistical significance framework, external experiment
storage, or measurements for every self-modification workflow in this iteration.

## Authoring contract

Store definitions in `experiments/<name>.mjs`. Prefer the current Node/ESM toolchain
with JSDoc imports of internal types; avoid adding a loader or runtime dependency
just to execute TypeScript. Types can live in `scripts/eval-experiments/types.ts`.
Wire type checking for these modules into an appropriate internal check.

```js
import { selfModificationCreationMetrics } from "../scripts/eval-experiments/measurements/self-modification.mjs";

/** @satisfies {import('../scripts/eval-experiments/types').Experiment} */
export default {
  evals: [
    {
      fixture: "agent-self-modification",
      include: [
        "self-modification/create-incident-triage",
        "self-modification/create-shipping-quote",
      ],
    },
  ],

  settings: {
    parent: { model: "provider/parent-model", reasoning: "high" },
  },

  matrix: {
    source: {
      baseline: { revision: "<full baseline SHA>" },
      shorterInstructions: { revision: "<full candidate SHA>" },
    },
    configuration: {
      modelAHigh: {
        selfModification: { model: "provider/model-a", reasoning: "high" },
      },
      modelAMedium: {
        selfModification: { model: "provider/model-a", reasoning: "medium" },
      },
      modelBHigh: {
        selfModification: { model: "provider/model-b", reasoning: "high" },
      },
    },
  },

  measurements: { creation: selfModificationCreationMetrics },

  sampling: { repetitions: 10, seed: 42 },

  analysis: {
    compare: { axis: "source", baseline: "baseline" },
    primaryMetric: "creation.elapsed",
    eligibility: "paired-correct",
  },
};
```

The example represents 2 sources × 3 configurations × 2 evals × 10 repetitions =
120 planned eval executions. The placeholder IDs and SHAs must be replaced before
execution. Check in an example with actionable instructions; never silently
substitute a live model or revision for placeholders.

### Matrix and settings semantics

- Both axes are explicit named maps. One source and several configurations is a
  normal model experiment; several sources and one configuration is a normal code
  experiment. The compared axis needs a baseline and at least one other entry.
- Source entries describe whole immutable commit trees. Do not apply candidate
  patches to the experiment checkout. Baseline-to-candidate diffs remain report
  evidence; independent candidates must not accidentally include one another.
- Configuration entries group valid model/reasoning combinations. Do not blindly
  cross every model with every reasoning value. Use full model IDs initially;
  model aliases do not belong to measurement modules.
- Scope settings explicitly to `parent` and `selfModification` for the initial
  fixture. The execution adapter rejects unsupported scopes rather than ignoring
  them. Do not invent a generic arbitrary-agent override API in this iteration.
- Shared `settings` supply fixed values. Merge a configuration over those values
  field-by-field within each scope, then record the fully resolved request in the
  plan. Validate reasoning against the existing eve-owned reasoning type; do not
  assume all providers support every value.
- Omitted reasoning means the fixture/provider default, not a known fixed value.
  Label it as such. Record requested settings separately from runtime-observed
  model IDs; do not claim reasoning was observed when events do not contain it.
- Configuration injection must not silently erase the source change under test.
  Document override precedence. An experiment varying authored model defaults
  should not simultaneously override those defaults at the same scope.

### Comparison semantics

`compare.axis: "source"` compares each non-baseline source against the baseline,
separately for every configuration and eval. `axis: "configuration"` does the
inverse, holding source and eval fixed. Support these two axes only initially.

Seeded repetition blocks reverse the shuffled compared-axis order on alternating
repetitions within each fixed-axis stratum. Runs remain serial until fixture
checkouts can be isolated for parallel execution. Pair samples by eval, fixed-axis entry, and repetition. A repetition is a
scheduling block, not a promise of identical provider randomness.

Preserve per-eval and per-configuration comparisons. Do not automatically pool
models or heterogeneous metrics. Initially retain paired medians/deltas and
positive-value ratios, with explicit sample and exclusion counts. Zero is a valid
count; do not drop it from medians or invent a ratio when its denominator is zero.
Cross-eval aggregates should be opt-in with documented weights and applicability;
omitting them initially is preferable to a misleading full-suite number.

## Measurement contract

A measurement module is a plain exported object. The experiment assigns its
namespace; there is no global registration or redundant authored name.

```ts
import type { EveEvalResult, EveEvalTaskResult } from "eve/evals";

// Internal projection of the existing on-disk eval detail artifact.
export type CapturedEval = Pick<
  EveEvalResult,
  "id" | "verdict" | "assertions" | "error" | "skipReason"
> & {
  result: Pick<EveEvalTaskResult, "sessions" | "derived" | "status">;
};

export type EventReference = { sessionId: string; eventId: string };

export type Measurement =
  | {
      status: "measured";
      value: number;
      evidence?: readonly EventReference[];
    }
  | { status: "unavailable"; reason: string }
  | { status: "not-applicable"; reason: string };

export interface MeasurementBundle {
  version: number;
  metrics: Record<
    string,
    {
      unit: string;
      direction: "lower" | "higher" | "neutral";
    }
  >;
  derive(captured: CapturedEval): Record<string, Measurement>;
}
```

Keep these types internal. Reuse exported eve types rather than copying event
unions, but validate parsed JSON at the artifact boundary. `JSON.parse` plus a
cast is not validation. A bounded reader should check the fields consumed and
surface unsupported artifact shapes as explicit analysis errors.

The existing artifact is not a complete `EveEvalResult`: it omits execution
start/completion timestamps and task-level events. Do not cast it to that type or
assume those fields are available. Additional existing artifact fields may be
exposed through the internal projection when a concrete measurement needs them.

### Example bundle

```js
/** @satisfies {import('../types').MeasurementBundle} */
export const selfModificationCreationMetrics = {
  version: 1,
  metrics: {
    elapsed: { unit: "ms", direction: "lower" },
    childDuration: { unit: "ms", direction: "lower" },
    toolCalls: { unit: "count", direction: "neutral" },
  },
  derive(captured) {
    return deriveCreationMetrics(captured.id, captured.result.sessions ?? []);
  },
};
```

The namespace in the experiment yields `creation.elapsed`,
`creation.childDuration`, and `creation.toolCalls`. All are retained and summarized;
`primaryMetric` only chooses the emphasized comparison. Units must flow into JSON
and Markdown output; remove generic result fields hardcoded with `Ms` suffixes.

Derivation is synchronous, deterministic, and side-effect-free. No network,
filesystem access, current time, source checkout, or live model calls. Helpers
inside the module can share correlation work across metrics. The harness checks
that all declared keys are returned, no undeclared keys appear, numeric values
are finite, and outcome shapes are valid. A thrown function or invalid return is
an analysis error, not an ordinary unavailable measurement; continue collecting
other results but report and fail the analysis operation explicitly.

### Creation measurement semantics

Move the branch's self-modification correlation code into this module, including
logic currently embedded in generic `extractSample`:

- Apply initially to the incident-triage and shipping-quote single-turn creation
  evals in the example. Other evals are `not-applicable`, not failed correctness
  runs. A small optional case-list metadata field can support preflight coverage
  warnings; do not load executable eval definitions merely to determine coverage.
- Index per-session event arrays and deduplicate delivery by event ID. Never
  concatenate the task-level NDJSON events with these arrays. Conflicting duplicate
  identities or ambiguous session evidence must not silently select a winner.
- Identify one relevant delegation to `self-modification__agent`, validating the
  child's invocation against the parent session, turn, and call IDs.
- Identify exactly one child turn and its matching completion. Failed, cancelled,
  parked, reused, or ambiguous episodes are unavailable, not successful timings.
- `elapsed`: parent `turn.started` to matching child `turn.completed`.
- `childDuration`: child `turn.started` to its matching `turn.completed`.
- `toolCalls`: distinct tool-call IDs requested within that child's complete turn.
  Missing or insufficient capture must not look like a complete count of zero.
- Require finite timestamps and nonnegative durations. Retain event references
  for auditing. Parent/child intervals overlap; never sum them.

Outcomes are per metric. A missing parent start can make `elapsed` unavailable
while leaving child duration and tool count measurable. A missing child timestamp
need not invalidate a count if the complete turn is otherwise established.

These durations exclude ingress, startup/build, verification conversations, and
teardown. Repair, approval, and background-task lifecycle measurements are deferred;
do not weaken correlation just to fill their report cells.

### Correctness and missingness

Derive measurements independently of assertion verdict. A completed child episode
may have valid timings even if a later correctness assertion fails. Preserve both
facts; `paired-correct` includes only pairs where both per-eval verdicts passed,
both executions are healthy, and the particular metric is measured.

- `not-applicable`: the metric intentionally does not cover this eval.
- `unavailable`: it should apply, but necessary execution evidence is absent.
- Analysis error: malformed artifact or broken measurement implementation.
- Execution error: preparation, process, restoration, or artifact collection failed.

Do not collapse these into a single `complete` flag. Report execution completeness,
measurement coverage, analysis errors, and correctness separately. A report can be
successfully generated while correctness regresses; never label that a winner.

## Data flow and ownership

```text
Trusted experiment revision
  definition + measurement modules
                ↓ resolve/validate
        immutable JSON plan
                ↓ isolated executions
        eve eval at source SHA
                ↓ archived evidence
     invocation records + eval artifacts
                ↓ artifact reader + derive
         per-eval measured samples
                ↓ compare matching strata
              JSON / Markdown
```

### Planner

Replace profile/model resolution with module loading and matrix expansion. Resolve
source SHAs, fully merged scoped settings, selected eval IDs, metric metadata, and
seeded schedules into plain data. Functions never enter the JSON plan.

Retain explicit limits on selections, repetitions, concurrency, total executions,
and artifact reads. Validate baseline references and primary metric names. Retain
source diffs; any allowed-diff policy belongs to the experiment/execution policy,
not a measurement bundle. Do not require the old two self-modification source
paths for every experiment. Keep a uniform-fixture invariant for source comparisons
so correctness definitions cannot change silently; record the shared fixture identity.

Reuse existing eval discovery/list semantics where practical. The branch's file
scanner does not cover all existing eval IDs (for example array-export cases);
reject unsupported selection forms explicitly rather than claim full discovery.

Record experiment revision, definition path, canonical plan hash, source revisions,
requested settings, measurement versions, and the measurement implementation revision.
Require a committed, clean definition and imported tool modules at the dispatched
revision. Executable definitions are trusted repository code; they are not a safe
format for untrusted uploads or arbitrary credential-bearing PR execution.

### Executor and fixture boundary

Keep `run.mjs`, checkout preparation, and Actions orchestration as the foundation.
Expose a coherent internal command entry point for planning, scheduled execution,
and reanalysis; Actions delegates to these operations instead of owning semantics.
Do not introduce a public eve command.

Move restoration checks, guarded fixture paths, and settings materialization to a
small fixture-specific adapter/helper. It owns execution concerns only, not model
catalogs, measurement selection, or allowed source diffs. Avoid a plugin registry
until multiple real adapters require one.

For the initial fixture, independently apply parent and self-modification model
and reasoning settings. Clear inherited experiment override variables before each
invocation; an omitted field must not inherit the preceding configuration. Preserve
normal non-experiment e2e behavior and keep judge configuration fixed.

Use candidate checkout code for the runtime and record whether that checkout
supports the required settings contract. Fail preflight when it cannot honor a
requested override; do not silently run older fixture code that ignores it.

Do not share mutable fixture trees between concurrent cells. Sequential reuse is
allowed only after verified restoration; quarantine a checkout after failure.
Retain process-group timeouts, bounded logs, raw artifacts, and invocation records
for failures as well as successes. Avoid unnecessary duplicate builds of the same
SHA, but correctness/isolation takes priority over build caching.

### Artifact reader and analysis

The current `eve eval` writer already emits
`.eve/evals/<timestamp>/evals/<eval-id>.json` containing the required per-session
captures. No reporter change or runtime instrumentation is needed for these metrics.
`extractDirectory` already reads these files; adapt it rather than replace collection.

Normalize artifacts into `CapturedEval`, call each bundle, namespace results, and
attach invocation provenance outside derivation. No need to pass an `EveEval`
definition, import its `test` function, or expose matrix metadata to measurement code.

Preserve every planned cell, including missing artifacts, in reports. Validate
sample provenance against the plan: experiment/plan identity, source SHA,
configuration/settings identity, fixture/eval, repetition, and measurement identity.
Reject duplicates and mismatches instead of joining on human-readable labels alone.

Reanalysis defaults to the pinned measurement implementation. Explicit reanalysis
with changed modules must retain original execution provenance and record the new
analysis revision and versions. Never silently rewrite an old report's meaning.
Include enough metadata in downloaded artifacts to reproduce the analysis.

## Migration and known defects

Replace the internal JSON manifest/profile format outright; no legacy fallback is
needed. Remove `profiles/`, update the workflow input and README together, and add
a committed example definition. Keep the workflow non-gating for normal product CI.

Address these defects while touching the relevant boundaries:

1. `extract.mjs` currently replaces every per-eval verdict with `failed` when the
   suite process exits 1. Preserve individual artifact verdicts; invocation health
   is separate. One failed eval must not invalidate unrelated passing cases.
2. `compare.mjs` joins samples without validating source/configuration provenance.
   Apply the checks above before comparison.
3. `prepare-checkouts.mjs` treats `import.meta.resolve("eve")` as a path, although
   it returns a file URL. Convert with `fileURLToPath` before checking resolution.
4. `readModelSettings` parses source with a regex and resolves the child source path
   relative to the fixture rather than repository root. Replace this with explicit
   requested settings and available runtime observations; do not infer effective
   model configuration from source text.
5. `runSchedule` identifies unsafe checkouts by matching error-message strings.
   Carry structured execution/restoration outcomes so wording cannot affect reuse.
6. Replace the README's missing manifest instructions with the actual module
   authoring contract, dispatch steps, artifact layout, and reanalysis commands.

Suggested implementation order: internal types and example; planner and schedules;
scoped fixture settings and execution records; artifact reader and pure measurement
module; unit-aware comparison and provenance validation; workflow/docs migration.
Reuse working code rather than adding parallel old and new pipelines.

## Validation and acceptance

Use the repository's test-tier rules. Script subprocess/filesystem tests should be
explicitly run as script tests or appropriate scenario tests, not disguised as pure
unit tests. Wire the internal harness tests into CI; the existing script tests are
not covered by the normal package unit-test glob.

Required coverage:

- Matrix counts, same-SHA configuration experiments, source comparisons across
  configurations, both comparison axes, deterministic ordering, budget validation.
- Field-level settings resolution, independent parent/child overrides, no inherited
  setting leakage, unsupported scopes/contracts rejected, fixed judge behavior.
- Existing correlation cases plus per-metric missingness, unsupported evals,
  duplicate evidence, missing call identities, invalid metric returns, and throws.
- Mixed passed/failed evals in one invocation preserve individual verdicts.
- Zero-valued counts, metric units, per-metric pairing, no unintended aggregation,
  missing samples, duplicate samples, and provenance mismatches.
- Checkout package resolution, restoration quarantine, and artifact preservation
  after execution failures.
- Offline reanalysis can add/change a measurement without launching subprocesses
  or contacting a provider, while recording distinct analysis provenance.

Run `node --test scripts/eval-experiments/*.test.mjs` (or its documented replacement),
relevant type checks, formatting, lint, and `pnpm guard:invariants`. For fixture
behavior changes, add/update deterministic fixture coverage and validate live
execution in CI, not locally. Report only checks actually run. This internal tooling
and fixture work does not require a changeset unless implementation expands into
the published eve package; avoid that expansion without a concrete need.

Acceptance: an author can define an instruction-change × model/reasoning experiment
without editing harness code, obtain separately attributed parent/child settings,
and rederive all selected metrics from downloaded artifacts. No profiles or new
public authoring APIs remain.
