# Datadog eval reporter fixture

This deterministic mock-model fixture creates one Datadog external experiment
with single-turn, multi-turn, and multiple-scorer eval cases. The reporter needs
Datadog API and application keys:

```bash
export DD_API_KEY="..."
export DD_APP_KEY="..."

pnpm --filter datadog-eval-reporter-fixture eval
```

Runtime tracing is optional. To also export the agent traces to Datadog, set the
standard OTLP variables before running the same command:

```bash
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="https://otlp.datadoghq.com/v1/traces"
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="dd-api-key=${DD_API_KEY},dd-otlp-source=llmobs"

pnpm --filter datadog-eval-reporter-fixture eval
```

The experiment rows and runtime spans share `eve.eval.run_id`, the generated
case id in `eve.eval.id`, and `eve.session.id`; `eve.eval.name` retains the
path-derived eval name on the experiment row. The reporter also records every
observed runtime trace context on that row.
