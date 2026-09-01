---
"eve": patch
---

Add a Datadog eval reporter that creates one LLM Observability Experiment per eve eval run and submits eval assertion metrics through the optional `dd-trace` package. The integration is tested against the public external Experiment API in `dd-trace@6.13.0`.
