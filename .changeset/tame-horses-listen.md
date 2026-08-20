---
"eve": patch
---

Prevent channel HITL responses from carrying channel-local metadata into strict session-inbox payloads. Built-in channel producers now define exact input responses so this drift fails typechecking before release.
