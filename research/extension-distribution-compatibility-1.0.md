---
issue: https://github.com/vercel/eve/pull/4855
status: in-progress
last_updated: "2026-10-22"
---

# Extension distribution compatibility for the 1.0 release candidate

## Authoring and manifest

Extension authors keep using the same `eve/*` APIs. `eve extension build` writes a format-3 `_manifest.json` containing the exact `builtWithEve` version and a distribution `contractMajor`, plus any `build.externalDependencies`. The build version is the minimum compatible consumer version, not an author-editable range. To support an older eve release, build against that release and test the same distribution against newer consumers.

Before mounting an installed extension, eve validates its manifest without executing extension code. An extension built on 1.3.2 runs on 1.3.4 if 1.3.4 preserves the old distribution's runtime behavior; a build on 1.3.4 does not run on 1.3.2, even when it uses no new APIs. A future major accepts an older distribution generation only after explicitly opting in and validating the runtime contract. npm peer ranges do not override the manifest check.

## The release-candidate cutover

The first release using format 3—potentially 0.85.0—rejects all format-1/2 epoch manifests, including extensions built on #4855. Source-backed workspace extensions rebuild against the installed eve version; authors of published, source-free extensions must publish new distributions. This is a coordinated migration for packages listed in the extensions registry, not a silent compatibility fallback. The epoch support table, history reports and fixtures, updater, and invariant rule disappear at this cutover. External dependency metadata remains in the manifest.

The release candidate stamps generation 0. If its distribution contract remains compatible through revisions and 1.0, keep the producer generation and consumer support list at `[0]`; a distribution built with the candidate then runs on 1.0 without rebuilding. If a change breaks that contract, advance the producer generation and decide whether the consumer can still support generation 0. If not, drop it and require another rebuild. The eve version comparison remains independent: a build on a later candidate cannot run on an earlier one even when they share a generation. Do not bump the generation merely because the eve package version reaches 1.0.

Preserve compatibility for older prebuilt distributions within a supported generation, not just TypeScript source compatibility. Test a distribution built against the candidate on subsequent consumers before carrying generation 0 into 1.0. A declaration check is not a substitute for a runtime compatibility test.
