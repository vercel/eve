---
"eve": patch
---

On a model with a per-user credential, a model-call error other than a rejected credential, such as a `403`, now fails only the turn with `MODEL_CALL_FAILED` instead of reporting a rejected credential, and no model-call error in such a session ends the session.

An OpenAI `invalid_prompt` refusal for a flagged prompt now fails only its turn on any model, and a refusal note replaces the flagged input in history, as for `cyber_policy` and `bio_policy`.
