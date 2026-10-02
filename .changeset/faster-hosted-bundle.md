---
"eve": patch
---

Hosted builds bundle faster: eve no longer re-parses its largest output chunk while adding the Node ESM compatibility banner, and Nitro no longer gzips every output file just to annotate the build log. The repeated `MISSING_CODE_SPLITTING_GROUP_DEBUG_NAME` warning also no longer appears in build logs.

eve no longer depends on `gray-matter`. Frontmatter and YAML files (skills, schedules, instructions, OpenAPI specs, and `loadYaml`) now parse with js-yaml 4, whose schema cannot evaluate code, and each deployed function is about 180 kB smaller. Frontmatter fences must be `---` or `---yaml`; other languages such as `---json` or `---js` now fail with an error instead of being parsed.
