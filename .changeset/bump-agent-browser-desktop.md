---
"@eve/agent-browser": patch
"@eve/agent-desktop": patch
---

Target agent-browser 0.41.2 and agent-desktop 1.2.0.

`@eve/agent-browser` now installs `agent-browser@0.41.2` by default. Its MCP tool catalog and sandbox helpers are unchanged from 0.41.1.

`@eve/agent-desktop` now installs `agent-desktop@1.2.0`, and `AGENT_DESKTOP_REVALIDATION_KEY` changes with it, so prepared sandbox templates rebuild. Since agent-desktop 1.1.0, a ref on Linux resolves only when its element was unique in the whole window: a ref to one of several identical controls, or from a snapshot that could not read the window whole (`identity_unproven: true`), fails with `AMBIGUOUS_TARGET` and kind `identity_not_unique`. Tool errors now include the error kind and say when repeating the same call returns the same refusal, and the instructions tell the agent to retake the snapshot with a larger timeout or pick a unique control instead of repeating the ref.
