---
"eve": patch
---

Fixed the default chat message reducer dropping assistant text when a single turn produced more than one message — for example, text shown before an OAuth authorization prompt was overwritten by the text that followed it once authorization completed. Each message now renders in the order it arrived.
