<img width="100%" alt="eve Software Factory Banner" src=".github/banner.png" />

# eve Software Factory Template

[![Docs](https://img.shields.io/badge/Documentation-000?style=flat-square&logo=readthedocs&logoColor=FFF&labelColor=000&color=000)](https://ask-foreman.dev/docs)
[![Agent Stack](https://img.shields.io/badge/Agent%20Stack-000?style=flat-square&logo=vercel&logoColor=FFF&labelColor=000&color=000)](https://vercel.com/kb/agent-stack)
[![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

Meet **Foreman**, an eve software factory that puts AI agents on every stage of the development loop and keeps people on the judgment calls.

Foreman takes tasks from GitHub and Linear, moves each one through four stations, and delivers a reviewed draft pull request on your repository. You review, mark ready, and merge.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?demo-title=eve+Software+Factory&demo-description=Software+factory+built+on+eve%3A+AI+agents+work+each+stage+of+the+development+loop%2C+and+people+make+the+judgment+calls.&project-name=eve-software-factory&repository-name=eve-software-factory-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-software-factory-template&env=FACTORY_REPO%2CFACTORY_LABEL&envDefaults=%7B%22FACTORY_LABEL%22%3A%22factory%22%7D&envDescription=FACTORY_REPO+is+the+owner%2Frepo+the+factory+works+on.+FACTORY_LABEL+is+the+issue+label+that+hands+an+issue+to+the+factory%3B+the+default+label+is+fine.&connect=%5B%7B%22type%22%3A%22github%22%2C%22env%22%3A%22GITHUB_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fgithub%22%7D%2C%7B%22type%22%3A%22linear%22%2C%22env%22%3A%22LINEAR_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Flinear%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22public%22%7D%5D&demo-image=%2F%2Fimages.ctfassets.net%2Fe5382hct74si%2F45PVqbeL5egwsqBRpGt6SQ%2F99e9f270dc22e07f499236af3a11a190%2Fimage.png&redirect-url=https%3A%2F%2Fask-foreman.dev%2Fwelcome)

## How it works

- **Classifier** triages the task: type, priority, complexity, actionable or not. When the task isn't actionable, Foreman asks the requester instead of building the wrong thing.
- **Analyst** turns it into a plan with acceptance criteria, working from a live checkout of your repository.
- **Implementer** executes the plan in its own sandbox, verifies with your repo's own checks, and pushes a branch.
- **Reviewer** independently judges everything against the real diff, with evidence for each verdict.

Each station is its own agent with its own instructions, sandbox, and tools. The Reviewer sees only the pushed branch, never the Implementer's reasoning. Between runs, Foreman keeps a **factory brain**: notes about your repository that every run starts from. See [the pipeline](https://ask-foreman.dev/docs/pipeline) and [factory memory](https://ask-foreman.dev/docs/memory) for the full picture.

## How work arrives

- **Label an issue `factory`.** The pipeline runs on its own, posts progress as stations complete, and ends with a draft PR linked to the issue.
- **@mention it on an issue or PR.** Mentions from repo owners, members, and collaborators start an interactive session.
- **Delegate in Linear.** Linear Agent Sessions run the same pipeline and report progress back in Linear.
- **The dev TUI.** Hand it a task locally. Changes to GitHub wait for your approval.
- **Red CI on a factory PR.** Foreman diagnoses the failure and pushes a fix to its own branches, never yours.
- **Someone opens a pull request.** Foreman posts one orienting comment for reviewers: a summary, not a review.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?demo-title=eve+Software+Factory&demo-description=Software+factory+built+on+eve%3A+AI+agents+work+each+stage+of+the+development+loop%2C+and+people+make+the+judgment+calls.&project-name=eve-software-factory&repository-name=eve-software-factory-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-software-factory-template&env=FACTORY_REPO%2CFACTORY_LABEL&envDefaults=%7B%22FACTORY_LABEL%22%3A%22factory%22%7D&envDescription=FACTORY_REPO+is+the+owner%2Frepo+the+factory+works+on.+FACTORY_LABEL+is+the+issue+label+that+hands+an+issue+to+the+factory%3B+the+default+label+is+fine.&connect=%5B%7B%22type%22%3A%22github%22%2C%22env%22%3A%22GITHUB_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fgithub%22%7D%2C%7B%22type%22%3A%22linear%22%2C%22env%22%3A%22LINEAR_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Flinear%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22public%22%7D%5D&demo-image=%2F%2Fimages.ctfassets.net%2Fe5382hct74si%2F45PVqbeL5egwsqBRpGt6SQ%2F99e9f270dc22e07f499236af3a11a190%2Fimage.png&redirect-url=https%3A%2F%2Fask-foreman.dev%2Fwelcome)

The Vercel deploy flow sets up everything: the **GitHub** connector, **Linear** connector, **Vercel Blob** store, and a prompt for the `FACTORY_REPO` and `FACTORY_LABEL` environment variables.

Two things must line up before Foreman can do any real work. `FACTORY_REPO` must name a real repository in `owner/repo` format, and the GitHub App behind the connector you select must be installed with access to that repository. A station's sandbox clones `FACTORY_REPO` on its first session, not at deploy time, so a repository the app cannot reach surfaces as a `Cannot access <owner/repo>` error on the first task you hand it, not the deploy itself; install the app on the repository (or fix the value), then try again.

Configuration (see `.env.example`):

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `FACTORY_REPO` | Yes | — | An existing GitHub repository in `owner/repo` format; the selected GitHub App must have access to it (a station's first session fails otherwise) |
| `FACTORY_SETUP_COMMAND` | No | — | Runs once per session inside the station sandbox checkout (e.g. `pnpm install`), so the station starts with dependencies already installed |
| `FACTORY_LABEL` | No | `factory` | The issue label that hands an issue to the factory |
| `FACTORY_BRANCH_PREFIX` | No | `factory/` | Branch prefix marking the factory's own PRs, which are the only branches automated CI fixes touch |
| `FACTORY_BOT_NAME` | No | the GitHub App's slug | The `@mention` name, resolved from the connector automatically when unset |
| `GITHUB_CONNECTOR` / `LINEAR_CONNECTOR` | Yes | — | Set automatically from Vercel Connect connector UIDs |

## Local development

Link the project you deployed (or a fresh one), pull its environment, and start the TUI:

```bash
vercel link
vercel env pull
pnpm dev
```

Hand the agent a task ("users report the password reset email arrives twice, fix it") and watch the four stations fire in order, ending in a draft PR on `FACTORY_REPO`. Local runs are treated as untrusted, so changes to GitHub wait for your approval in the TUI.

## Resources

- [Foreman Docs](https://ask-foreman.dev/docs)
- [Vercel Connect](https://vercel.com/docs/connect)
- [eve Documentation](https://eve.dev/docs/introduction)
- [GitHub Tools eve Extension](https://github-tools.com/frameworks/eve-extension)

## Explore more templates

- [eve Marketing Team](https://vercel.com/templates/eve/eve-marketing-team)
- [eve Personal Agent](https://vercel.com/templates/nuxt/eve-personal-agent)
- [eve Sanity Copilot](https://vercel.com/templates/eve/eve-sanity-copilot)
