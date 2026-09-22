# Datadog eval reporter fixture

This deterministic mock-model app exercises the Datadog eval reporter against
`dd-trace@6.13.0`.

```bash
export DD_API_KEY="..."
export DD_APP_KEY="..."
export DD_SITE="datadoghq.com"

pnpm --filter datadog-eval-reporter-fixture eval
```

Without both Datadog keys, the fixture omits the reporter so the shared local,
Postgres, and Vercel e2e matrices remain hermetic.

The credentialed run creates a Datadog dataset with one record containing `Say hello.`,
creates one LLM Observability Experiment against that dataset version, links the
record to the smoke eval's synthetic experiment span, attaches the assertion
metrics, and prints the Dataset and Experiment URLs. The fixture does not export
the agent runtime's OpenTelemetry spans; Datadog's public dataset and external
Experiment APIs generate the record, trace, and span identifiers.
