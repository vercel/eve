---
"eve": patch
---

Agent spans now carry `vercel.session_id` (set to the root session id) when running on Vercel, so traces can be equality-looked-up across all session windows via an indexed column. The attribute is omitted in local `eve dev`.
