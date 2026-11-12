---
"eve": minor
---

Add an experimental `defineHarness` in `eve/experimental/harness`. An agent's `harness.ts` (and a mounted extension's) changes how a turn runs in stages: `next`, `admit`, `tools`, `instructions`, `history`, and `compact`. Each stage wraps the same stage below it, ending with eve's own behavior, and `extends: false` removes eve's. A harness can call tools itself, settle a turn without the model, and compact the history its own way, while every call still goes through eve's approval and sign-in checks.
