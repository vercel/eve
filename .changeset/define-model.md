---
"eve": minor
---

`defineModel({ id, auth, create })` from `eve/models` runs a model on the caller's own credential: eve resolves `auth` before each model call, opens the same sign-in as a connection when the caller has none, continues the same turn after the callback, retries a rejected token once before it asks again, and fails a turn without a credential with `MODEL_AUTHORIZATION_FAILED`.

A turn also fails with `MODEL_CREDENTIAL_FAILED` when `auth` throws another error, such as an unreachable credential service, and with `MODEL_CREATE_FAILED` when `create` throws.
