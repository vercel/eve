# eve/extensions/loops

`eve/extensions/loops` notices when a turn repeats the same tool calls without progress. It nudges the model with a system instruction that names the loop, and stops the turn if the loop comes back.

It ships inside the `eve` package. This private `@eve/loops` workspace package is its source of truth: eve's build copies `extension/` into `packages/eve/src/extensions/loops/extension` and publishes it as `eve/extensions/loops`.

## Mount

```ts
// agent/extensions/loops.ts
import loops from "eve/extensions/loops";

export default loops({});
```

## What it contributes

- A `call.settled` hook that fingerprints each call's tool name and input, and its outcome and output, keeps the turn's last `window` of them in `defineState`, and checks them for three patterns: `repeated-result`, `alternating-calls`, and `repeated-call`.
- A dynamic system instruction that shows the latest nudge for the rest of its turn.

The first `maxNudges` loops in a turn nudge (default 1). The next one calls `ctx.cancel()`, which stops the turn before its next model call. Configuration and patterns are documented in `docs/loops-extension.md`.

## Validate

```sh
pnpm --filter @eve/loops typecheck
pnpm --filter @eve/loops test
```
