---
"eve": patch
---

Fix `useEveAgent` crashing with React error #185 ("Maximum update depth exceeded") when a live session opens its stream behind the tail, such as after `send()`, and more than ~50 of the session's earlier lines arrive at once.

The store now publishes that catch-up when its stream reaches the tail instead of once per historical line, as `resume()` already did since #3866. Events after the tail still publish as they arrive, and `onEvent` and `onSessionChange` still run for every event.
