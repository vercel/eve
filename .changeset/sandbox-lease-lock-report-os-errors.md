---
"eve": patch
---

Report the operating system error when the sandbox GitHub credential lock cannot be created, written or reclaimed (a full disk, a read-only or missing `/tmp`), instead of retrying for 60 seconds and blaming another command that holds the credentials.
