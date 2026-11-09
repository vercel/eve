# eve/experimental/extensions/custom-skills

`eve/experimental/extensions/custom-skills` lets the people talking to an agent save their own versioned skills: personal skills that follow a user everywhere, and shared skills for everyone in a channel or group chat. It is experimental and may change in any release.

- User-facing docs: [`docs/experimental/custom-skills.md`](../../docs/experimental/custom-skills.md)
- Design and invariants: [`research/custom-skills.md`](../../research/custom-skills.md)

This private `@eve/custom-skills` workspace package is the extension's source of truth. eve's build copies `extension/` into `packages/eve/src/extensions/custom-skills/extension` and publishes it as `eve/experimental/extensions/custom-skills`, with helpers at `/policies` and `/repository`.

## Layout

- `extension/lib/lifecycle.ts`: versions, drafts, publish, rollback, modes, limits, and validation, over any `SkillRepository`.
- `extension/lib/tool-support.ts` and `extension/lib/approval.ts`: each changing tool's approval and execution, built from one planner so the approval rule judges exactly what the tool writes.
- `extension/lib/document-repository.ts`: the default store, over an `eve/memory/file` backend.
- `extension/lib/public/`: the `/policies` and `/repository` entry points.

## Validate

```sh
pnpm --filter @eve/custom-skills typecheck
pnpm --filter @eve/custom-skills test
EVE_E2E_MODEL=mock pnpm --filter agent-custom-skills exec eve eval --strict
```
