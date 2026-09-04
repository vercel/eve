---
issue: "TBD (Datadog Experiments reporter partner request)"
status: proposed
last_updated: "2026-09-01"
---

# Datadog Experiments reporter for eve evals

Add a reporter that publishes an eve eval run to Datadog LLM Observability
Experiments without asking the Datadog SDK to rerun the task.

## Authoring API

```ts
import { defineEvalConfig } from "eve/evals";
import { Datadog } from "eve/evals/reporters";

export default defineEvalConfig({
  reporters: [
    Datadog({
      projectName: "weather-agent",
      recordInputs: false,
      recordOutputs: false,
    }),
  ],
});
```

One shared reporter instance creates one Experiment for the run. Each completed
eval becomes one synthetic experiment span, and each assertion becomes an
Experiment metric associated with the span returned by Datadog.

```text
evals.config.ts ── Datadog(...) ──► Experiment
                                      ├─ eval row + assertion metrics
                                      ├─ eval row + assertion metrics
                                      └─ completed/failed status
```

## SDK boundary

Target the public external Experiment API in `dd-trace@6.13.0`:

- `tracer.llmobs.experiments.createDataset(...)`
- `dataset.push()`
- `tracer.llmobs.experiments.startExperiment(...)`
- `experiment.submitSpan(...)`
- `experiment.submitEvaluationMetrics(...)`
- `experiment.close(...)`

`submitSpan` generates and returns the row's `traceId` and `spanId`. Its input
does not accept caller-owned `id`, `traceId`, `spanId`, or `apmTraceId` fields.
The reporter must not fabricate those fields or mutate `dd-trace` internals.
Keep `dd-trace` optional and load it from the app so the published `eve` package
does not gain a runtime dependency.

Initialize LLM Observability with both `projectName` and `mlApp`. Resolve the
project from explicit reporter config, `DD_LLMOBS_PROJECT_NAME`, ml_app config,
`DD_LLMOBS_ML_APP`, `DD_SERVICE`, or the first eval id, in that order.

## Row mapping

- `name`: the path-derived eve eval id.
- `input`, `output`, and expected output: opt-in because they may contain user
  data. When input recording is enabled, completed evals are buffered until run
  completion, their inputs are pushed as versioned dataset records, and each
  experiment span carries its generated dataset record id. Expected output is
  included in the dataset record only when present and explicitly enabled.
- `metadata`: verdict, status, session id, tool/subagent names, authored eval
  metadata, sanitized target origin, and local git metadata when available.
- `tags`: eval id, verdict, status, and authored eval tags.
- metrics: assertion scores under normalized descriptive assertion names plus
  tool, subagent, message, and reasoning counts. Gate labels receive a `gate_`
  prefix, and authors can set stable names with `.label(...)`. Raw assertion-name
  tags and failure messages require the explicit `recordAssertionDetails`
  privacy opt-in.
- timestamps: the values already captured by the eval runner.
- error: opt-in because exception messages may contain application data.

All metadata, config, inputs, and outputs are normalized to the JSON value shape
accepted by `dd-trace` before submission.

## Trace-linking boundary

The external Experiment API creates a synthetic row span and does not support
post-hoc association with an already-ingested agent runtime span. Do not add
private propagation headers, expose trace identifiers in stream events, force
global Datadog environment variables, or mutate private `dd-trace` span fields
to simulate that association.

If Datadog adds a public linking API later, eve can expose an internal,
reporter-visible trace link and submit it through that API. Synthetic spans
remain the fallback for remote or uninstrumented targets.

## Validation

- Unit-test experiment lifecycle, dataset creation and record linkage, row
  mapping, privacy switches, metric labels, project resolution, summary status,
  and URL logging with an injected client.
- Pin `dd-trace@6.13.0` as an eve development dependency and in the deterministic
  reporter fixture so TypeScript and runtime API smoke checks exercise the
  supported release.
- Run the targeted reporter and runner unit tests, eve typecheck, dependency
  checks, invariant guards, docs checks, and `git diff --check`.
- Use real Datadog credentials only for manual dogfood verification; CI tests
  remain deterministic and network-free.
