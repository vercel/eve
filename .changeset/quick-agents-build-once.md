---
"eve": patch
---

Reduce development startup and production build time by removing duplicate bundler work, skipping unnecessary parsing, and overlapping independent preparation. Development terminal inspection now has a deadline, and `Client.info()` accepts an abort signal so slow inspection requests do not hold up startup.
