---
"eve": patch
---

eve's default sandbox image is now tagged by its Dockerfile contents instead of the eve version, so upgrading eve reuses existing sandbox templates unless the image itself changed. Expect one template rebuild on the first upgrade to this release.
