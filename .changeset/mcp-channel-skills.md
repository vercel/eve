---
"eve": patch
---

`mcpChannel({ skills: true })` serves the agent's skills as SEP-2640 skills under `skill://`, with each file's size and SHA-256 digest. Files are served byte for byte, except that a `SKILL.md` without conforming `name` and `description` frontmatter is served with generated frontmatter. Channel routes also get `readSkill(skill, path?)`, which returns one skill file's bytes, and `describe()` now lists each skill with its files and their sizes.

Production builds now ship skill files as eve-owned server assets and drop Nitro's default `server` asset entry, which bundled the app's `assets/` directory. An app that read `assets:server` storage in production finds it empty; eve reads only its own asset bases.
