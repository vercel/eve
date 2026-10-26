---
"eve": minor
---

eve's default sandbox image is now tagged by its Dockerfile contents instead of the eve version, so upgrading eve reuses existing sandbox templates unless the image itself changed. Expect one template rebuild on the first upgrade to this release.

The default sandbox image no longer includes pnpm or pip, which makes it smaller. Install them in your sandbox `prepare` callback when your agent needs them: run `npm install -g pnpm` for pnpm, and use a Python virtual environment for pip.
