# Retained capability compatibility

When eve continues to support an older extension capability epoch, add an
authored TypeScript fixture at `<capability>/v<epoch>.ts`. The fixture must use
the old contract in a representative way and continues to compile against the
current eve API whenever capability contracts are checked.

Only compact API hashes and authoring roots are committed for each epoch. When
the current hash changes, the updater regenerates the previous API from the Git
commit that recorded that epoch and compares it with the working tree. Full API
Extractor reports remain temporary build artifacts.

Capability entrypoints root extraction at public authoring values such as
`defineTool` and `defineHook`; API Extractor follows every type reachable from
their signatures. Export a type from an entrypoint only when it is a standalone
extension API that no authoring value reaches. The invariant checks both value
ownership and type reachability.

`pnpm update:extension-contracts --update <capability>` retains the previous
epoch automatically when its declaration change is structurally backward
compatible, updates the support table, and creates a marked scaffold at the
required path. Replace that scaffold with the representative example before
rerunning `pnpm update:extension-contracts` to create the new epoch metadata. Use
`--retain` to confirm a change the classifier cannot prove, or `--drop "reason"`
when the current consumer cannot run the previous epoch.

Keep the fixture immutable once merged. Structural compatibility is only one
part of consumer support, so retain focused runtime coverage for any behavior
that changed across the epoch boundary.
