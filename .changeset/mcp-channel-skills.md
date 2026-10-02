---
"eve": patch
---

`mcpChannel({ skills: true })` serves the agent's skills as SEP-2640 skills under `skill://`, byte for byte, with each file's size and SHA-256 digest. Channel routes also get `readSkill(skill, path?)`, which returns one skill file's bytes, and `describe()` now lists each skill with its files and their sizes.
