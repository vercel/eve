---
"eve": patch
---

Fix Discord Gateway daemon dependency installation with an eve release candidate.

Generated relay packages now resolve Vercel Connect's eve peer to the relay's selected eve version, so npm does not reject a prerelease that Connect's broad peer range excludes.
