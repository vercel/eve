---
"eve": patch
---

Sessions started before eve 0.57 that used a sandbox now start a fresh sandbox after they are imported, instead of failing every sandbox call with `Sandbox session state belongs to provider "undefined"` and later failing deployment handoff. The sandbox from before the upgrade is not reused.
