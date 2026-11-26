---
"eve": minor
---

Add `ClientNetworkError`, `TurnFailedError`, and `SessionFailedError` to `eve/client`, so callers can identify a request that got no response and a failure the server recorded with `is()` instead of matching messages.

`ClientNetworkError` wraps a `fetch` rejection of a valid request before any response, keeps its `message`, holds the original as `cause`, and still extends `TypeError`. Invalid requests, a redirect refused in Node.js, and aborts still reject as before, and stream opens still retry a disconnect before throwing it.

`SessionStore` and `useEveAgent` now report a failed turn as `TurnFailedError` and a failed session as `SessionFailedError` through `error` and `onError`. Both keep the recorded `message` and keep the recorded failure code in `name`. They carry the full recorded `ErrorInfo` on `info`, and a failed turn also carries its `turnId`.
