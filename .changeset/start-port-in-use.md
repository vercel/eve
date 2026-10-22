---
"eve": patch
---

`eve start` and the `withEve` production server for Next.js now fail fast with a clear "port is already in use" error when another process holds the port, instead of reporting a server they did not start and leaving the built server running in the background. Thanks @KingAmo for reporting this in #4938.
