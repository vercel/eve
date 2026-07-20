---
"eve": patch
---

Errors that escape a session — not just model-call failures — now pass through a semantic-error catalog: declarative, linter-style rules applied to any thrown error. Rules cover AI Gateway (auth, model-not-found, rate limits, upstream availability), model providers (missing API keys, unsupported capabilities), the durable workflow runtime (store version/access, replay divergence, corrupted event logs), sandbox backends (Docker CLI/daemon, provisioning), and system failures (port in use, disk full, network dials). Matched failures render a stable, actionable summary in the transcript with the raw error routed to the `eve dev` diagnostic log, and failure events carry a stable `semanticErrorId` for correlation.
