---
"eve": patch
---

HTTP Basic auth now compares the username and password in constant time on every request, so response timing no longer reveals whether the username matched.
