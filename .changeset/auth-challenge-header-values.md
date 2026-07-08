---
"eve": patch
---

Sanitize CR and LF characters from generated `www-authenticate` challenge parameter values so malformed auth details cannot inject additional response headers.
