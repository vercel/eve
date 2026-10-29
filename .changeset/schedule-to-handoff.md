---
"eve": patch
---

Messages a schedule sends with `to()` on Vercel now carry the deployment that ran the schedule, so an idle session they continue hands off to the new deployment like one a route reaches.

Thanks @dohooo for reporting this in #5598.
