---
"eve": patch
---

Fix `useEveAgent({ resume: true })` crashing with React error #185 ("Maximum update depth exceeded") when a saved session replays more than ~50 events. The store now publishes once after catch-up instead of once per replayed event.
