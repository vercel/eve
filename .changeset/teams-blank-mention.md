---
"eve": patch
---

Fix a crash when an agent is triggered by a bare mention with no text (e.g. sending just `@bot` in a Microsoft Teams channel). The agent now responds normally instead of failing.
