---
"eve": patch
---

Local development leaves previous invocations' workflows dormant by default. `eve dev --resume` attempts to recover runs with valid retained snapshots even when framework or authored workflow sources changed; replay can fail after executing work. Missing snapshots are cancelled, while runs with malformed generation metadata remain stored and dormant. Requests addressed to dormant conversations fail instead of appearing accepted without a response.
