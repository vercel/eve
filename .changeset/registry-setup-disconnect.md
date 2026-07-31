---
"eve": patch
---

Connection registry items now configure their Vercel Connect connector during `eve add`, and registry setup commands close their IPC channel after reporting an outcome so `/add` returns instead of remaining stuck.
