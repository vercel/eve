---
"eve": patch
---

For session owners that record their deployment URL, eve now detects deleted Vercel deployments and returns `409 session_stranded` or starts a replacement session for a channel message instead of silently accepting input that cannot run. Thanks @nafisazizir for reporting this and @ruiconti for the original fix in #5383.
