---
"eve": patch
---

A message sent to a session within 30 seconds of its last turn now starts its turn on the session's still-running orchestrator instead of a fresh queue delivery that reloads and replays the session, because eve defaults `WORKFLOW_ORCHESTRATOR_HOOK_LINGER_MS` to 30 seconds.
