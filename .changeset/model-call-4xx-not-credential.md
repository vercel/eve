---
"eve": patch
---

On a model with a per-user credential, a provider error other than a rejected credential, such as a flagged prompt or a `403`, now fails only the turn with `MODEL_CALL_FAILED` and the provider's message instead of reporting a rejected credential, and no model-call error on such a model ends the session.
