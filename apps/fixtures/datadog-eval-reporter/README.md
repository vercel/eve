# Datadog eval reporter fixture

This fixture gives the Datadog team a small, deterministic eve app for
developing the eval reporter. Its mock model needs no model-provider
credentials.

The reporter is currently a no-op skeleton. The app's `instrumentation.ts`
does export the eval's runtime trace to Datadog through the standard OTLP
environment variables:

```bash
export DATADOG_API_KEY="..."
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="https://otlp.datadoghq.com/v1/traces"
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="dd-api-key=${DATADOG_API_KEY},dd-otlp-source=llmobs"

pnpm --filter datadog-eval-reporter-fixture eval
```

Use the regional OTLP endpoint for a Datadog site outside US1. Implement the
three lifecycle placeholders in the Datadog reporter to create an Experiment,
submit each completed eval, and finalize the run.
