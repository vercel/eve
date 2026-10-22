---
"eve": patch
---

Avoid an extra setup command when creating a Vercel sandbox from a prepared snapshot of the standard eve image without Drive mounts. eve now checks the base runtime again after authored preparation, so a `prepare` callback that breaks it fails the build; existing sandboxes, resumes, custom images or sources, Drive mounts, and sandboxes without a prepared snapshot keep their setup checks. Vercel templates rebuild once so every snapshot has passed the new check.
