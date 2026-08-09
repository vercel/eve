---
"eve": patch
---

Sessions no longer stall while an interactive authorization challenge is open: ordinary messages now run as normal turns during the wait, and the OAuth callback still completes the challenge — including when parked activity like no-op cancels or descendant-routed deliveries consumes the wait. Session timeouts are also honored during an open challenge. The authorization park now closes its turn boundary (`turn.completed` → `session.waiting`), so stream consumers no longer hang on a parked turn, and `client.fetch` preserves query strings embedded in the request path.
