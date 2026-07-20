---
"eve": patch
---

The session stream now emits `action.preparing` the moment the model commits to a tool call, while the call's input is still streaming from the provider. The dev TUI uses it to surface each upcoming call immediately — a placeholder row with the tool's activity verb (`Fetch …`) that upgrades in place once the full input arrives, plus a `Preparing tool calls…` status — instead of a stale transcript during input generation. Subagent streams get the same treatment inside their nested region.
