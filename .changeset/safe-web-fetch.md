---
"eve": patch
---

Harden `web_fetch` against SSRF by requiring HTTPS, rejecting non-public destinations during DNS resolution, and returning redirect targets without following them automatically.
