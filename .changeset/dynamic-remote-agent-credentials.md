---
"eve": patch
---

Dynamic remote agents carry `auth` and `headers` from `render`. A child keeps the record it was opened with: every later request to it renders its credentials from that record, and only for the destination it was opened at.
