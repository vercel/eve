---
"eve": patch
---

Catalog calls now read as what happened: `eve__search` shows `Search tools for “linear issues”` and then how much it found, a skill load shows `Load skill <name>` and then `Loaded skill <name>`, and a connection's sign-in entry shows `Sign in to Linear`. Linear activities, Chat SDK typing indicators, and ACP tool calls now show each call's label instead of its raw tool name, and `eve/client` tool parts carry that text as `toolMetadata.eve.label`.
