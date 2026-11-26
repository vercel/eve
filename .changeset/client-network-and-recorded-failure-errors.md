---
"eve": minor
---

Add `TurnFailedError` and `SessionFailedError` to `eve/client`, so callers can distinguish recorded turn and session failures with `is()`.

`SessionStore` and `useEveAgent` expose these failures through `error` and report live failures through `onError`. Both errors keep the recorded message and keep the recorded failure code in `name`. Both carry the full recorded `ErrorInfo` on `info`, and `TurnFailedError` also carries `turnId`. Fetch errors and retry behavior are unchanged.
