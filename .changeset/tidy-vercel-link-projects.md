---
"eve": patch
---

Create new Vercel projects through `vercel link` instead of posting directly to the projects API. This lets the Vercel CLI apply its framework and local config handling while eve reads the resulting link metadata, keeps framework-specific eve host integrations when detected, and otherwise ensures new projects use the eve framework preset.
