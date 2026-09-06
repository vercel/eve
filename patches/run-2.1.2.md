# Run suspension and guest error repair

This patch keeps host cancellation outside guest exception handling and identifies failures originating in user source without classifying generic infrastructure errors.

The pnpm patch `run@2.1.2.patch` changes only the published `dist/runtime/worker-source.js`. `run-2.1.2-source.patch` is the readable upstream source and regression-test change that generated it; pnpm does not apply that companion file.

Source: [vercel-labs/run at 2ec44925f5ff](https://github.com/vercel-labs/run/tree/2ec44925f5ff7eb3afc0deae0c0e234c4ed48229), package `run@2.1.2`, embedded `quickjs-wasi@3.6.0`. These are the versions already used by the unpatched package. The prior local suspension repair was preserved; this revision also marks guest eval/rejection failures as `RUN_USER_SOURCE_ERROR`, preserving trusted host bridge codes and real timeout/protocol errors.

To reproduce from a clean checkout of that commit:

```sh
git apply /path/to/run-2.1.2-source.patch
pnpm install --frozen-lockfile
pnpm --filter run build
pnpm --filter run test:node
```

Then run `pnpm patch run@2.1.2` in eve, copy the resulting `packages/run/dist/runtime/worker-source.js` into the patch directory at `dist/runtime/worker-source.js`, and run the printed `pnpm patch-commit` command. Run `pnpm --filter eve build:compiled` to regenerate eve's SDK bundle; never edit that bundle directly.

Built worker SHA-256: `826f5a8dae6c1d05eb05dab443f24711fe349360f881556d4f5380ad6bea88a1`.
Readable source patch SHA-256: `d56060c9b5e74b6c98e2035cfdd40f75c360423b9b45ab4e13f61c7b750bdfda`.

Validation: all 336 Run tests in 26 files passed on Node with this build. The source tests cover catch/finally suspension, no repeated settled side effects, late bridge responses and worker reuse, guest error provenance, actual host failures, and real CPU timeout recovery. All 13 tests in eve's `program-step.integration.test.ts` passed against the regenerated compiled SDK. Both Run typechecks, banned-pattern checks, lint, and formatting passed; the readable patch applies cleanly to the pinned commit. These in-process regressions do not claim cross-process exactly-once delivery.
