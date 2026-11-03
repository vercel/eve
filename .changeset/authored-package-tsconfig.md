---
"eve": patch
---

Every eve build now reads `paths` aliases from the authored package's own `tsconfig.json` or `jsconfig.json`, and an asset import that leaves the authored package fails the build.

The Nitro host, authored module bundles, and the workflow driver share one resolver. The workflow driver no longer searches parent directories for a config, and an agent nested in a package without its own `package.json` uses that package's config in every build. Before, only `?raw` asset imports were checked against the package root; now plain imports such as `import notes from "../../notes.txt"` are too. Extensionless imports of dotted directories, such as `./helpers.v2`, still resolve to the directory's index module.
