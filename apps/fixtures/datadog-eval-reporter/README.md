# Datadog eval reporter fixture

This deterministic mock-model app exercises the Datadog eval reporter against
`dd-trace@6.13.0`.

```bash
export DD_API_KEY="..."
export DD_APP_KEY="..."
export DD_SITE="datadoghq.com"

pnpm --filter datadog-eval-reporter-fixture eval
```

The run creates one Datadog LLM Observability Experiment, submits one synthetic
experiment span for the smoke eval, attaches the assertion metrics, and prints
the Experiment URL. The fixture does not export the agent runtime's OpenTelemetry
spans; Datadog's external Experiment API generates the experiment row's trace
and span identifiers.
