---
"eve": patch
---

Rework `eve dev` structural reloads to never interrupt admitted work: an isolated candidate must compile, bundle, and start before it is promoted atomically, the retired worker keeps serving the responses and sockets it already admitted until they settle, and a failed candidate or crashed worker leaves the server available with shutdown bounded even while streams are open.
