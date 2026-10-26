---
"eve": patch
---

`localDev()` now refuses requests that a browser sends for another website: a non-loopback request host or `Origin`. A web page open in the developer's browser can no longer start sessions or run the agent's tools on an `eve dev` server, including through DNS rebinding. Frontends served from any loopback host and port still authenticate.
