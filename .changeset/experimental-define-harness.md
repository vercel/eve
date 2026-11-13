---
"eve": minor
---

Add an experimental `defineHarness` in `eve/experimental/harness` that changes how an agent's turns run.

An agent's `harness.ts` (and a mounted extension's) changes a turn in stages: `next`, `model`, `tools`, `instructions`, `context`, `request`, `admit`, `compact`, and `on`. A stage that's a function wraps the same stage below it, ending with eve's own behavior, and `extends: false` removes eve's; values and `on` handlers are collected from every layer. A harness can call tools itself, settle a turn without the model, wait on tasks, decide what each message that arrives during a turn does, and compact the history its own way, while every call still goes through eve's approval and sign-in checks.
