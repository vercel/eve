# Template source apps

These are standalone source projects for the eve template gallery. Each directory owns its `package.json`, `pnpm-lock.yaml`, and framework configuration so people can copy or deploy it without the eve workspace.

The [Data Agent Template](./eve-data-agent-template/README.md) adds a Slack agent backed by dbt models, with local DuckDB or MotherDuck selected by connection string. It is listed as **Data Agent** in the template gallery.

The root workspace intentionally excludes these projects. Do not use `workspace:` dependencies or import files from elsewhere in this repository. Keep `eve` as a normal npm dependency and update the template lockfile when its dependencies change.

Deploy with Vercel clones a template from `main` and installs its committed lockfile, so the template must work with the published `eve` version that lockfile pins. When template code needs a newer `eve` API, bump `eve` and regenerate the lockfile in the same change, once that version is published.

Some templates copy files unchanged from `apps/docs/registry`, such as the eve Web Chat components, or from another template, such as the chat template's auth helpers. `scripts/sync-template-files.mjs` lists them; edit the source, not the copy. Run `pnpm sync:template-files` to update the copies; `pnpm check:template-files` fails in CI when a copy drifts or is not marked `linguist-generated` in `.gitattributes`.

Run `pnpm check:templates` from the repository root to copy every template to a temporary directory and check it twice: first with its committed lockfile and `typecheck`, then against a packed local `eve` package with its `typecheck` and `build` scripts.

## Repository mapping

The upstream repositories below are the source of truth for their templates. Maintain these copies alongside eve, bring in upstream changes, and contribute local fixes back upstream through pull requests to reach parity. Changes are not automatically synchronized. A dash means no separate upstream remote is recorded.

See the [upstream parity review](./UPSTREAM-PARITY.md) for the reviewed revisions and remaining differences.

| Internal template                                                   | Upstream remote                                                                                           |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`bell-stack`](./bell-stack/)                                       | [browserbase/bell-stack](https://github.com/browserbase/bell-stack)                                       |
| [`eve-agent-python-template`](./eve-agent-python-template/)         | [vercel-labs/eve-agent-python-template](https://github.com/vercel-labs/eve-agent-python-template)         |
| [`eve-chat-template`](./eve-chat-template/)                         | [vercel-labs/eve-chat-template](https://github.com/vercel-labs/eve-chat-template)                         |
| [`eve-coding-agent-template`](./eve-coding-agent-template/)         | [vercel-labs/eve-coding-agent-template](https://github.com/vercel-labs/eve-coding-agent-template)         |
| [`eve-content-agent-template`](./eve-content-agent-template/)       | [vercel-labs/eve-content-agent-template](https://github.com/vercel-labs/eve-content-agent-template)       |
| [`eve-contentful-agent-template`](./eve-contentful-agent-template/) | [vercel-labs/eve-contentful-agent-template](https://github.com/vercel-labs/eve-contentful-agent-template) |
| [`eve-data-agent-template`](./eve-data-agent-template/)             | —                                                                                                         |
| [`eve-data-analyst-template`](./eve-data-analyst-template/)         | [vercel-labs/eve-data-analyst-template](https://github.com/vercel-labs/eve-data-analyst-template)         |
| [`eve-discord-agent-template`](./eve-discord-agent-template/)       | —                                                                                                         |
| [`eve-llm-council-template`](./eve-llm-council-template/)           | [vercel-labs/eve-llm-council](https://github.com/vercel-labs/eve-llm-council)                             |
| [`eve-mem0-template`](./eve-mem0-template/)                         | [mem0ai/eve-mem0-template](https://github.com/mem0ai/eve-mem0-template)                                   |
| [`eve-memory-agent-template`](./eve-memory-agent-template/)         | [vercel-labs/eve-memory-agent-template](https://github.com/vercel-labs/eve-memory-agent-template)         |
| [`eve-slack-agent-template`](./eve-slack-agent-template/)           | [vercel-labs/eve-slack-agent-template](https://github.com/vercel-labs/eve-slack-agent-template)           |
| [`eve-software-factory-template`](./eve-software-factory-template/) | [vercel-labs/eve-software-factory-template](https://github.com/vercel-labs/eve-software-factory-template) |
| [`eve-sre-agent-template`](./eve-sre-agent-template/)               | [vercel-labs/eve-sre-agent-template](https://github.com/vercel-labs/eve-sre-agent-template)               |
| [`eve-tanstack-start-template`](./eve-tanstack-start-template/)     | [vercel-labs/eve-tanstack-start-template](https://github.com/vercel-labs/eve-tanstack-start-template)     |
| [`eve-vercel-drives-starter`](./eve-vercel-drives-starter/)         | [vercel-labs/eve-vercel-drives-starter](https://github.com/vercel-labs/eve-vercel-drives-starter)         |
| [`eve-voice-template`](./eve-voice-template/)                       | —                                                                                                         |
| [`kody-eve-template`](./kody-eve-template/)                         | [vercel-labs/kody-eve-template](https://github.com/vercel-labs/kody-eve-template)                         |
| [`marketing-team-eve-template`](./marketing-team-eve-template/)     | [vercel-labs/marketing-team-eve-template](https://github.com/vercel-labs/marketing-team-eve-template)     |
| [`openinstinct`](./openinstinct/)                                   | [Merit-Systems/OpenInstinct](https://github.com/Merit-Systems/OpenInstinct)                               |
| [`personal-agent-template`](./personal-agent-template/)             | [vercel-labs/personal-agent-template](https://github.com/vercel-labs/personal-agent-template)             |
| [`sanity-copilot-eve-template`](./sanity-copilot-eve-template/)     | [vercel-labs/sanity-copilot-eve-template](https://github.com/vercel-labs/sanity-copilot-eve-template)     |
| [`slack-company-brain-template`](./slack-company-brain-template/)   | —                                                                                                         |
