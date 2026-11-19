# @eve/self-improvement

Read the root AGENTS.md, CONTRIBUTING.md, and this package README before changes.
Use the workspace Node and pnpm versions. Read docs/extensions/index.md before
changing the extension contract.

Keep runtime contributions in extension/, portable exports in api/, and isolated
regressions in test/integration/. Run the package typecheck, integration tests,
build, and packed-consumer scenario when changing installation or exports.

Private Blob is the default store. The optional Postgres adapter preserves
existing ledgers; never switch an existing backend on errors. Keep credentials,
transcripts, operator records, and production fixtures out of source and reports.

Only the real scheduled runtime identity can start a cycle. Candidate sandboxes
have no publishing or production authority. Preserve fenced recovery, independent
verification, required checks, signed commits, and the trusted release boundary.
Installing or building this package starts no job; the host mounts and deploys it.
