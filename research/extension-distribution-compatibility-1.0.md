---
issue: https://github.com/vercel/eve/pull/4855
status: in-progress
last_updated: "2026-10-22"
---

# Extension distribution compatibility at 1.0

## Authoring and manifest

Extension authors keep using the same `eve/*` APIs. `eve extension build` writes a format-3 `_manifest.json` containing the exact `builtWithEve` version and a distribution `contractMajor`, plus any `build.externalDependencies`. The build version is the minimum compatible consumer version, not an author-editable range. To support an older eve release, build against that release and test the same distribution against newer consumers.

Before mounting an installed extension, eve validates its manifest without executing extension code. An extension built on 1.3.2 runs on 1.3.4 if 1.3.4 preserves the old distribution's runtime behavior; a build on 1.3.4 does not run on 1.3.2, even when it uses no new APIs. A future major accepts an older distribution generation only after explicitly opting in and validating the runtime contract. npm peer ranges do not override the manifest check.

## The 1.0 boundary

**All pre-1.0 distributions require rebuilding**, including extensions built on #4855. Format-1/2 epoch manifests fail with a targeted rebuild/install diagnostic. Source-backed workspace extensions rebuild against the installed eve version; authors of published, source-free extensions must publish new distributions. This is a coordinated ecosystem migration for packages listed in the extensions registry, not a silent compatibility fallback.

#4855 still has package version 0.82.0, so the prototype stamps generation 0. When the package becomes 1.0, change the producer generation and consumer support list to `[1]`; this also rejects format-3 distributions built against the release candidate. Do not ship generation 0 as the stable 1.0 contract. At the cutover, the epoch support table, history reports and fixtures, updater, and invariant rule are removed together. The manifest format retains external dependency metadata.

After 1.0, preserve compatibility for older prebuilt distributions within a supported generation, not just TypeScript source compatibility. Test an older published distribution on a newer consumer and make any decision to support prior generations explicit. A declaration check is not a substitute for a runtime compatibility test.
