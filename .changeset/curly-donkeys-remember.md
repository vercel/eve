---
"eve": patch
---

Fix tool-approval denial breaking resumable sessions against OpenAI. When a HITL approval is denied, eve persists an `execution-denied` tool-result marker into the session transcript so the UI can render the denial; on the next turn, the replayed marker reached the AI SDK provider adapter unrecognised and OpenAI 400s the request with `Missing required parameter: 'input[N].output'`, permanently wedging the session. eve now down-projects the marker to a provider-safe `error-text` output on the model-call boundary only — persisted history and `action.result` projection preserve the authoritative `execution-denied` shape (with the original reason) for UI and telemetry consumers.
