---
"eve": patch
---

Model-call failures now surface AI Gateway correlation details — `generationId`, plus the `provider` and `model` actually routed to — in both `step.failed` details and logs, including for failures the semantic-error catalog does not recognize (those previously logged a raw inspector dump with no structured fields). `generationId` is the join key for looking up the upstream cause in gateway telemetry. A gateway stream that ends before its terminal chunk is also now treated as transient, so it retries with backoff instead of parking the session on first contact.
