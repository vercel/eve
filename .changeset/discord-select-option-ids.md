---
"eve": patch
---

A Discord `display: "select"` request with an option `id` longer than 100 characters now fails with a clear error instead of posting a select whose truncated value came back as an id the request never offered, which dropped or mismatched the user's choice.
