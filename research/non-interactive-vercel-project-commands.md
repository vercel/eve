---
issue: TBD
last_updated: "2026-08-14"
status: proposed
---

# Non-interactive Vercel project commands

## Summary

`eve link` and `eve deploy` need an explicit non-interactive mode for coding agents and CI. Today `eve link` only presents eve-owned team and project pickers. `eve deploy` infers whether it may prompt from TTY presence, which means a caller cannot reliably prohibit prompts and an unlinked project cannot be linked as part of a headless deploy.

## CLI contract

```sh
eve link --non-interactive --project <name-or-id> [--team <team-id-or-slug>]
eve deploy --non-interactive --yes --project <name-or-id> [--team <team-id-or-slug>]
```

The project and team argument syntax and resolution match `vercel link`: `--project` accepts a Vercel project name or ID, and `--team` accepts a team ID or slug. A non-interactive `eve link` requires `--project`; it links with Vercel's non-interactive flags and pulls the project environment into `.env.local`.

A non-interactive `eve deploy` requires `--yes` as the explicit production-deploy acknowledgement. With `--project`, it first performs the same non-interactive link, including environment pull, then deploys. Without `--project`, it deploys an existing link; an unlinked directory fails without side effects. Neither command opens a browser, invokes login, or falls back to a picker in non-interactive mode.

Missing arguments, Vercel authentication failures, unknown projects, and failed subprocesses produce ordinary actionable stderr and a nonzero exit. These commands have a fixed argument surface, so they do not introduce `eve add`'s NDJSON question protocol.

## Boundaries

Interactive `eve link` and `eve deploy` retain their current eve-owned selection and onboarding flows. The new mode delegates project identity parsing and scope semantics to Vercel CLI rather than creating an eve-specific project resolver. `eve init` is out of scope: its coding-agent-aware handoff already avoids launching an interactive child process.
