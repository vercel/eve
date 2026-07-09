---
"eve": patch
---

Hardened frontmatter parsing and OpenAPI connection loading.

All frontmatter parsing now runs through a single safe-by-default helper with gray-matter's code-capable engines disabled, so a `---js` / `---javascript` fence throws instead of being `eval()`d. Previously only authored markdown (skills, schedules, instructions) was hardened; the eval YAML loader and the OpenAPI spec loader used gray-matter's defaults and would execute such a fence. This closes that path for OpenAPI specs, which are fetched over the network. Parsing untrusted frontmatter as code is now opt-in only, and a direct import of the bundled gray-matter outside the wrapper fails CI.

OpenAPI spec URLs and the resolved base URL are now required to use `https` (plain `http` is still allowed for loopback hosts during local development), so neither the spec fetch nor the credentialed operation calls run over cleartext; the spec transport is also re-checked after redirects.
