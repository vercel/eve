---
"eve": patch
---

Serialize optional sandbox engine auto-installs and reload newly installed engines through their package entrypoint file instead of retrying the cached bare specifier. This prevents first-run `eve dev` sessions from racing microsandbox installation or surfacing Node's stale same-process module-not-found result after Bun installs `microsandbox`.

`eve init` also supports `EVE_INIT_PACKAGE_SPEC` so local tarball/source validation can make the generated project install the same eve build under test instead of resolving the published semver range from the registry.
