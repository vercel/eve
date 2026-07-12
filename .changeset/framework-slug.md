---
"eve": patch
---

Vercel deployments now emit `framework: { slug: "eve" }` alongside the version in the Build Output API config. Vercel's build-output deserializer drops the entire `framework` object when `slug` is absent, so this restores framework attribution end to end — `framework_slug` and `framework_version` are now populated in AI Gateway routing and access logs.
