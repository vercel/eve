---
"eve": patch
---

Sessions whose workflow run cannot execute after an eve upgrade (a stranded session) are no longer accepted and left unanswered, and the local World and Postgres stop replaying and failing them with `CORRUPTED_EVENT_LOG`. eve treats every World other than Vercel as running one eve version at a time, so the next message through a channel address (Slack, `from(address).send()`) ends a stranded session and starts a fresh one. Sends by session ID throw `SessionStrandedError` (`ClientSessionStrandedError` in `eve/client`), and the eve HTTP channel returns `409 session_stranded`; `reset()` ends a stranded session while `clear()` refuses one, and recorded history stays readable with `stream({ follow: false })` or `follow=false` on the stream route. On Worlds other than Vercel, a retired session's own session timeout now ends it at its deadline, so a retired session no longer stays active forever when no message arrives.
