---
"eve": patch
---

Stop exposing Microsandbox credential-broker transform rules in guest command environments. Brokered secrets now remain with the Microsandbox secret API while sandbox-visible Git configuration uses only placeholder values.
