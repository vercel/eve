---
"eve": patch
---

Remote session stream proxies now reject unexpected content types and prevent upstream responses from being served as executable content. Error responses with unexpected content types are replaced with generic JSON while preserving the error status.
