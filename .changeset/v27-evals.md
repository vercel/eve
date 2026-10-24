---
"eve": minor
---

Evals now use v27 facts and interaction projections, with call matchers such as `turn.waitForToolCall()` and renamed helpers such as `calledAgent()` and `awaitingInput()`. The `remoteUrl` field and matcher are removed; use the [v27 upgrade guide](https://eve.dev/docs/concepts/upgrade-to-v27-events) to migrate legacy assertions.
