# Datadog eval reporter fixture

This deterministic mock-model fixture creates one Datadog external experiment
with single-turn, multi-turn, and multiple-scorer eval cases. The reporter needs
Datadog API and application keys:

```bash
export DD_API_KEY="..."
export DD_APP_KEY="..."

pnpm --filter datadog-eval-reporter-fixture eval
```

The fixture enables `Datadog()` when both credentials are present. Without
them, it still runs the deterministic eval cases without reporting, including
in the repository's e2e matrix.

Runtime tracing is optional. To also export the agent traces to Datadog, set the
standard OTLP variables before running the same command:

```bash
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="https://otlp.datadoghq.com/v1/traces"
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="dd-api-key=${DD_API_KEY},dd-otlp-source=llmobs"

pnpm --filter datadog-eval-reporter-fixture eval
```

When runtime tracing is enabled, the reporter includes the trace contexts
captured by the eval runner on each experiment row. This is the same
`eveTraceIds` and `eveTraceContexts` metadata used by the Braintrust reporter.
