# Captured eve 0.82 and 0.83 handoffs

These fixtures were emitted by running `workflowEntry` from each release tag,
not assembled from checkpoint types. Each owner completed one HTTP-channel
turn for Alice, parked durably, then received Bob's delivery targeting another
deployment. The capture reads the hydrated `startSuccessorStep` arguments and
the original stream's raw NDJSON records (before the handoff).

The model uses the existing integration harness's deterministic AI Gateway stub;
no provider calls or channel credentials are involved. Captures use the release's
source, workflow transform and test setup, with shared installed development
dependencies. The 0.83 captures use the current checkout's vendored artifacts
(`@workflow/core` 5.2.3, also pinned by those releases). The 0.82.0 capture instead
uses its published `eve@0.82.0` distribution for the vendored artifacts and `dist`
imports, including its pinned Workflow 5.2.0 runtime. These are real workflow-owner
captures, not complete dependency-pinned package installations or two-deployment
Vercel tests.

Only the synthetic session ID is replaced with `captured-session`. Event IDs,
timestamps, model usage, context caches, history, compaction metadata, and state
remain as emitted. No credentials or personal data were present.

| Release | Source commit                              |
| ------- | ------------------------------------------ |
| 0.82.0  | `714ca1e29ec6fcd0c5305c15442e30405e698035` |
| 0.83.0  | `261043d87ef0844a705c2ccf90ce5ea77d1c0bf9` |
| 0.83.1  | `68c09772ff2b6d02ebd045111c8652abd17e17a8` |
| 0.83.2  | `9f73f9dbe5841253657b9037614cb43887937fe8` |
| 0.83.3  | `b83e100c572a9e18007f49e27b6f7a5cae0625c5` |

## Reproduce a capture

Use a clean checkout of the release tag, with its dependencies and compiled
artifacts available. Copy `capture.integration.test.ts.txt` into
`packages/eve/src/execution/session/capture-v26.integration.test.ts`; it is kept
as text here because it targets the old test API, not the current one. Run from
that checkout's `packages/eve`:

```sh
V26_CAPTURE_VERSION=0.83.3 \
V26_CAPTURE_OUTPUT="$TMPDIR/captured-0833.json" \
pnpm exec vitest run --config vitest.integration.config.ts \
  src/execution/session/capture-v26.integration.test.ts
```

For eve 0.82.0, also set `V26_CAPTURE_CHECKPOINT_VERSION=16` and use its published
`dist/src/compiled` artifacts and `dist` imports rather than the current build's
vendored Workflow 5.2.3. The 0.83 releases write version 17, which is the harness default. The 16→17 upgrade changes no
checkpoint data: version 17 introduced the proactive-preparation idle-deadline
contract.

Repeat from clean source for each release; do not overlay a newer source tree
onto an older tag. Replace only the emitted session ID with `captured-session`
before checking the output in. The current integration test binds that ID to a
fresh stream, exercises version-3 hook takeover, and verifies the successor's
first position, turn identity, history, and accumulated model usage.

See [Channel-state audit](./CHANNELS.md) for the separate platform-state review.
