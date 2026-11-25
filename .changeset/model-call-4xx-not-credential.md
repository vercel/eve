---
"eve": patch
---

On a model with a per-user credential, a provider `4xx` other than `401`, such as a flagged prompt or a `403`, now fails the turn with `MODEL_CALL_FAILED` and the provider's message instead of reporting a rejected credential; the session stays open as before.
