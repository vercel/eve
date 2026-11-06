# @eve/custom-skills Extension Package

This private package is the source of the `eve/extensions/custom-skills` extension. It lets the people talking to an agent save their own versioned skills, personal or shared with a Slack channel, and applies them on later turns.

Before writing code, read the installed eve package docs for extensions, tools, skills, instructions, and memory as applicable.

## Boundaries

- `extension/lib/lifecycle.ts` is storage-independent: it talks only to `SkillRepository` and never inspects the scope. Keep validation, drafts, publish, rollback, modes, and always-on limits there.
- Storage details belong in a repository. `document-repository.ts` stores skills in an eve memory document backend; consumers can pass their own `repository` instead.
- Tools address skills by their normalized name. Keep tool names bare (`create`, not `create_skill`); the mount supplies the namespace.
- Keep shared implementation under `extension/lib/`; filesystem paths define contribution names.

## Build and publish

The eve build copies `extension/` into `packages/eve/src/extensions/custom-skills/extension` and compiles it into the `eve` package; the public entry point is declared in `packages/eve/package.json`. Do not publish this package or add it as an eve dependency (it depends on eve). Import only public `eve/*` APIs from `extension/`. Keep tests under `test/unit/` and `test/integration/`, outside the discovered extension tree. Run typecheck, both test tiers, eve's build, lint, and package-scoped formatting before completion.
