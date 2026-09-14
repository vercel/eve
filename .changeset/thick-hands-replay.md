---
"eve": patch
---

Fix `prepareAgentStart` treating a replayed dispatch step's own handle registration as corruption. `mintStartOperation` derives handle identity deterministically so durable step replays derive the same handle record; re-preparing the same identity for the same operation while the handle is starting or running is now a replay no-op (mirroring `confirmAgentStarted`), while a matching identity under a different operation still throws. Previously, a crash between an accepted subagent start and the dispatch step result's commit made every replay fail with `Agent handle "…" already exists.`, escalating to a fatal `dispatchRuntimeActionsStep failed after 3 retries` that killed the session. Also reject empty `callId`/`parentSessionId`/`parentTurnId` at mint time instead of failing later at persist with an opaque corrupt-handle-store error.
