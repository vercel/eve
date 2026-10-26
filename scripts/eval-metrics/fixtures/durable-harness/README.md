# durable-harness conformance data

The framework overhead metrics in `scripts/eval-metrics/framework.mjs` use the
definitions of durable-harness's `/compare` page
(`packages/demo-ui/src/compare-glossary.ts`). This directory pins them down.

- `eve-tool-turn.ndjson`, `eve-steer.ndjson`: eve session streams recorded by
  [vercel-labs/durable-harness](https://github.com/vercel-labs/durable-harness)
  (`packages/bench/src/fixtures/`), copied unchanged. Copyright Vercel, Inc.,
  licensed under the Apache License, Version 2.0.
- `expected.json`: for each stream, a synthetic client clock and the marks and
  `/compare` breakdown that durable-harness's own code (`EveTranslator`,
  `turnView`, `breakdown`) computes from it, at the commit it records.
- `generate.mjs`: writes `expected.json` from a durable-harness checkout.

`standard.test.mjs` checks that our derivation gives the same marks and values,
and that `METRIC_DEFINITIONS.commit` in `standard.mjs` matches `expected.json`.
When either repository changes a definition, add or regenerate the fixtures in
both, then bump `METRICS_VERSION` if a value's meaning changed:

```sh
pnpm --dir <durable-harness> exec tsx \
  scripts/eval-metrics/fixtures/durable-harness/generate.mjs <durable-harness>
```
