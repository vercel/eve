---
"eve": patch
---

Add a Datadog eval reporter that creates one LLM Observability Experiment per eve eval run and submits eval assertion metrics through the optional `dd-trace` package. Opted-in eval inputs are pushed as versioned dataset records and linked to their experiment rows. The integration is tested against the public dataset and external Experiment APIs in `dd-trace@6.13.0`.
