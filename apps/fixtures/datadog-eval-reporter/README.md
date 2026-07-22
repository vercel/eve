# Datadog eval reporter fixture

This deterministic mock-model eval uses the no-op Datadog reporter and exports
its runtime trace through the standard OTLP environment variables:

```bash
export DATADOG_API_KEY="..."
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="https://otlp.datadoghq.com/v1/traces"
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="dd-api-key=${DATADOG_API_KEY},dd-otlp-source=llmobs"

pnpm --filter datadog-eval-reporter-fixture eval
```

Implement the reporter's three lifecycle placeholders to create an Experiment,
submit each completed eval, and finalize the run.
