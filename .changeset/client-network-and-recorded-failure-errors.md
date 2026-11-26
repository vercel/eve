---
"eve": minor
---

Add `ClientNetworkError`, `TurnFailedError`, and `SessionFailedError` to `eve/client`, so callers can tell an unreachable agent and a failure the server recorded apart from other errors with `is()` instead of matching messages.

`ClientNetworkError` wraps a `fetch` rejection that happens before any response, keeps its `message`, holds the original as `cause`, and still extends `TypeError`. Aborts still reject with the signal's reason, and stream opens still retry a disconnect before throwing it.

`SessionStore` and `useEveAgent` now report a failed turn as `TurnFailedError` and a failed session as `SessionFailedError` through `error`, `onError`, and rejected commands. Both keep the recorded `message` and carry the full recorded `ErrorInfo` on `info`, and a failed turn also carries its `turnId`. Their `name` is now the class name and their `code` is `turn_failed` or `session_failed`; read the recorded failure code from `info.code` instead of `name`.
