---
"eve": patch
---

Errors that escape a session — not just model-call failures — now pass through a semantic-error catalog. Recognized failure shapes (AI Gateway auth, missing provider keys, network dial failures) render a stable, actionable summary in the transcript with the raw error routed to the `eve dev` diagnostic log, and failure events carry a stable `semanticErrorId` for correlation.
