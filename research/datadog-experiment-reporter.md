---
issue: "TBD (Datadog Experiments reporter partner request)"
status: proposed
last_updated: "2026-07-27"
---

# Datadog Experiments reporter for eve evals

Datadog Experiments is the right destination for offline CI eval runs: one eve
run should create one Datadog Experiment, and each completed eval case should
become one experiment row with scores, metadata, and eventually a link back to
the agent runtime trace.

## MVP scope

Ship a reporter that can publish completed eve eval results to Datadog
Experiments without re-running the task inside the Datadog SDK.

```
evals/evals.config.ts ── Datadog(...) ──► one Datadog Experiment
        │
        └─ onEvalComplete(result) ───────► one synthetic experiment span + metrics
```

The MVP intentionally uses synthetic experiment spans built from the eval
result. Post-hoc linking to an already-ingested agent span is the next step once
Datadog exposes that association capability.

## Datadog SDK surface needed

The current Node Experiments shape owns the dataset/task/evaluator loop. eve
already owns that loop, so the reporter only needs hooks for creating an
Experiment, generating/submitting one experiment span per completed row, and
submitting eval metrics that reference that generated span id.

Proposed public Node contract:

```ts
type ExperimentMetricValue = boolean | number | string | Record<string, unknown>;

interface StartExperimentOptions {
  /** Experiment display name. */
  name: string;
  /** Optional override; defaults to DD_LLMOBS_ML_APP or DD_SERVICE. */
  projectName?: string;
  description?: string;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
  config?: Record<string, unknown>;
  /** Optional dataset linkage when the caller has one. Not required for MVP. */
  dataset?: {
    id?: string;
    name?: string;
    version?: string | number;
  };
}

interface ExperimentSpanInput {
  /** Stable caller-owned row id, e.g. eve eval id. */
  id?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  expectedOutput?: unknown;
  metadata?: Record<string, unknown>;
  tags?: Record<string, string>;
  startedAt?: Date | string | number;
  completedAt?: Date | string | number;
  durationMs?: number;
  error?: Error | string | { type?: string; message: string; stack?: string };
  datasetRecordId?: string;
}

interface ExperimentSpan {
  experimentId: string;
  spanId: string;
  traceId: string;
  url: string | null;
}

interface EvaluationMetricInput {
  label: string;
  value?: ExperimentMetricValue;
  error?: Error | string | { message: string };
  tags?: Record<string, string>;
  timestamp?: Date | string | number;
}

interface ExperimentRecorder {
  readonly experimentId: string;
  url(): string | null;

  /**
   * Generates an LLM Obs experiment span id/trace id, serializes the row as an
   * experiment span, submits it, and returns the identifiers the caller should
   * use for eval metrics.
   */
  submitSpan(row: ExperimentSpanInput): Promise<ExperimentSpan>;

  /**
   * Submits eval metrics for an already-submitted experiment span. Each metric
   * is associated to the row by `span.spanId` and to the run by
   * `span.experimentId`.
   */
  submitEvaluationMetrics(
    span: Pick<ExperimentSpan, "experimentId" | "spanId">,
    metrics: readonly EvaluationMetricInput[],
  ): Promise<void>;

  /** Best-effort status patch + flush. */
  close(options?: { status?: "completed" | "failed"; error?: Error | string }): Promise<void>;
}

interface Experiments {
  startExperiment(options: StartExperimentOptions): Promise<ExperimentRecorder>;
}
```

Usage from the eve reporter:

```ts
const experiment = await tracer.llmobs.experiments.startExperiment({
  name: "eve evals",
  projectName: "weather-agent",
  tags: { source: "eve" },
});

const span = await experiment.submitSpan({
  id: result.id,
  input: evaluation.description,
  output: result.result.output,
  metadata,
  startedAt: result.startedAt,
  completedAt: result.completedAt,
  error: result.error,
});

await experiment.submitEvaluationMetrics(span, [
  { label: "gate:succeeded", value: 1 },
  { label: "similarity", value: 0.92 },
]);

await experiment.close({ status: summary.failed > 0 ? "failed" : "completed" });
```

This deliberately keeps span generation and eval metric submission separate so
custom eval runners can submit metrics after they know the generated experiment
span id. A convenience `submitRow({ ...row, metrics })` can be added later, but
the lower-level contract should remain public.

Until that public API exists, keep any direct Datadog HTTP client in one private
adapter so it can be removed without changing the eve reporter API.

## eve code changes

1. Replace `src/evals/runner/reporters/datadog.ts` with a real optional-peer
   reporter:
   - export `Datadog(config?: DatadogReporterConfig)` and its config type from
     `eve/evals/reporters`.
   - dynamically import `dd-trace` or a Datadog SDK adapter so `eve` does not
     gain a hard runtime dependency.
   - accept config for `projectName`/`mlApp`, `experimentName`, `datasetName`,
     `tags`, `metadata`, `recordInputs`, `recordOutputs`, and an optional
     injected client for tests.
2. On `onRunStart`, create/resolve the Datadog project, materialize a dataset
   record per observed eve eval, then create a fresh Experiment for the run.
3. On `onEvalComplete`, map an `EveEvalResult` to one Datadog row:
   - `id`: eve eval id.
   - input/expected: eval description and/or dataset metadata that eve exposes.
   - output/error/timestamps: `result.result.output`, `result.error`,
     `startedAt`, `completedAt`.
   - scores: soft assertions by assertion name; gate assertions as binary
     `gate:<name>` metrics.
   - metadata: eval metadata, verdict, skip reason, session id, tool/subagent
     call counts, failed assertion messages, runtime identity, and git metadata.
4. On `onRunComplete`, flush pending rows, patch Experiment status
   (`completed` or `failed`), and print the Datadog Experiment URL.
5. Add docs in `docs/evals/reporters.mdx`, a changeset for `eve`, and keep all
   user-facing copy spelling the framework as `eve`.

## Runtime trace-linking follow-up

The reporter cannot currently discover the agent turn's real OTel span. The
harness stores `traceId`/`spanId` in internal session state to keep model-call
spans parented, but that state is not exposed through eval results.

Add a durable, reporter-visible trace link without requiring reporters to
instrument the black-box agent:

1. Extend the stream protocol with trace context on a turn lifecycle event, e.g.
   `turn.started.data.trace = { traceId, spanId }` when telemetry is enabled.
2. Add `EveEvalTraceLink` to `EveEvalTaskResult`/`EveEvalSessionResult`, derived
   from captured stream events.
3. Teach `Datadog` to send `{ traceId, spanId }` when present.
4. Once Datadog supports post-hoc association, switch from synthetic spans to
   `attachSpan({ traceId, spanId, scores, metadata })` for instrumented agents,
   with synthetic spans retained as the fallback.

## Example project

Expand `apps/fixtures/datadog-eval-reporter` into the correctness fixture and
manual dogfood app:

- real dependencies: `eve`, `dd-trace`, `@vercel/otel`, and OTel exporter
  packages needed for Datadog trace submission.
- deterministic `mockModel()` agent so CI and local checks do not need model
  credentials.
- `agent/instrumentation.ts` that enables OTel/Datadog telemetry for runtime
  traces.
- `evals/evals.config.ts` using `Datadog({ projectName: "eve-datadog-fixture" })`.
- `README.md` and `.env.example` showing both modes:
  - local verification against a fake Datadog HTTP endpoint;
  - manual verification against Datadog with `DD_API_KEY`, `DD_APP_KEY`,
    `DD_SITE`, and `DD_LLMOBS_ML_APP`.

## Test plan

- Unit tests for the reporter mapping: lifecycle order, missing SDK error,
  no-op before `onRunStart`, score/metadata conversion, skipped/error rows,
  summary status, URL logging, and `recordInputs`/`recordOutputs` privacy
  switches.
- Integration tests with an injected fake Datadog client or mocked `fetch` that
  assert exact project/dataset/experiment/events/status payloads without real
  network access.
- Runner-level test to prove config reporters still dedupe and the Datadog
  reporter receives scoped summaries.
- Scenario test using `apps/fixtures/datadog-eval-reporter` and `eve eval
--strict`; point the reporter at a local fake Datadog server and assert one
  experiment plus one row is submitted.
- Manual dogfood test with real Datadog credentials: run the fixture, open the
  printed Experiment URL, verify scores, metadata, run summary, and (after the
  follow-up) the link to the runtime trace.

## Open questions

- What exact public Node SDK API and package version should eve target for the
  recorder-style Experiments surface?
- Does Datadog require a persisted dataset for every Experiment, or can external
  eval rows create an Experiment without dataset records?
- What is the backend contract for post-hoc linking to an already-ingested span?
- Should eve expose expected output/inputs to reporters beyond description and
  metadata, or keep that data entirely user-authored via eval metadata?
