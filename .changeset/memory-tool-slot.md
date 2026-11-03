---
"eve": patch
---

Memory slots and schedule collections now offer their tools themselves, so agent info no longer lists them as generated dynamic tool files.

A tool file at `agent/tools/<slot>.ts` or `agent/tools/schedule__<name>.ts` still replaces those tools, and `disableTool()` there still removes them. Sessions and approvals parked across the upgrade keep working.
