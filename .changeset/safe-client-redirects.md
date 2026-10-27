---
"eve": minor
---

Client requests now reject redirects by default, including session writes and event streams. Update redirecting base URLs to their final destination, use `redirect: "manual"` to stop at redirects, or explicitly opt into `"follow"` only when every redirect destination is trusted.
