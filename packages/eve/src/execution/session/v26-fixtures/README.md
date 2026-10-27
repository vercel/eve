# Captured eve 0.83 handoffs

These fixtures were emitted by running `workflowEntry` from each release tag,
not assembled from checkpoint types. Each owner completed one HTTP-channel
turn for Alice, parked durably, then received Bob's delivery targeting another
deployment. The capture reads the hydrated `startSuccessorStep` arguments and
the original stream's raw NDJSON records (before the handoff).

The model uses the existing integration harness's deterministic AI Gateway stub;
no provider calls or channel credentials are involved. Capture used the release's
source, workflow transform and test setup with the current checkout's installed
dependencies and vendored artifacts (`@workflow/core` 5.2.3, also pinned by these
releases). This is a real workflow-owner capture, not a published-package install
or a two-deployment Vercel test.

Only the synthetic session ID is replaced with `captured-session`. Event IDs,
timestamps, model usage, context caches, history, compaction metadata, and state
remain as emitted. No credentials or personal data were present.

| Release | Source commit                              |
| ------- | ------------------------------------------ |
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

Repeat from clean source for each release; do not overlay a newer source tree
onto an older tag. Replace only the emitted session ID with `captured-session`
before checking the output in. The current integration test binds that ID to a
fresh stream, exercises version-3 hook takeover, and verifies the successor's
first position, turn identity, history, and accumulated model usage.

See [Channel-state audit](./CHANNELS.md) for the separate platform-state review.
