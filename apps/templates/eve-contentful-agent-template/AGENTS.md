# eve Contentful Agent

This repository is a reusable Slack-based Contentful assistant built on eve. It supports arbitrary Contentful schemas and stores a searchable copy of configured content on Vercel Drives. Use Node.js 24 and pnpm.

These instructions are for agents maintaining the repository. The assistant's behavior is defined in [agent/instructions.md](agent/instructions.md) and the dynamic instructions under `agent/instructions/`.

## Project map

| Change | Location |
| --- | --- |
| Assistant behavior and writing guidelines | `agent/instructions.md` |
| Contentful context and current time | `agent/instructions/` |
| Model and session limits | `agent/agent.ts` |
| Tool definitions | `agent/tools/` |
| Contentful configuration and implementation | `agent/lib/contentful/` |
| Publication approvals | `agent/tools/publish_contentful_entry.ts` and `agent/lib/contentful/publication*.ts` |
| Slack channel and shared integration code | `agent/channels/slack.ts` and `agent/lib/integrations/slack/` |
| Slack tables and charts | `agent/lib/tools/` and `agent/lib/integrations/slack/visualizations/` |
| Search and query procedures | `agent/skills/` |
| Content copied to Vercel Drives | `agent/lib/contentful/mirror/` and `agent/schedules/` |
| Local and hosted sandbox selection | `agent/sandbox.ts` |
| Per-user writing preferences | `agent/memory/user-preferences.ts` and `agent/lib/memory/scope.ts` |
| Setup and customization guidance | `README.md`, `CUSTOMIZATION.md`, and `.env.example` |

Keep this template independent of the original internal content agent. Do not add organization-specific space IDs or content types to application code. Team membership restrictions are an optional extension described in `CUSTOMIZATION.md`; they are not enabled by default.

## Before implementing changes

Inspect the relevant implementation and nearby tests. For eve API changes, start with [the installed documentation index](node_modules/eve/docs/README.md), then read the page it identifies for the task. Use [eve's published documentation](https://eve.dev/docs) if the installed docs are unavailable. Verify third-party APIs against the installed package or current official documentation rather than relying on recalled signatures.

Keep discovery bounded: read the routed documentation and the files needed for the change, then implement. Follow imports or public types only when they resolve a specific unanswered question. Do not recursively scan dependencies or read unrelated framework pages.

Content-only changes to the assistant's instructions do not require framework research. Preserve the configured model unless changing it is part of the request.

For a new external integration, check the eve registry before writing an integration from scratch:

```sh
pnpm exec eve registry search <query> --json
pnpm exec eve registry view <item>
```

Prefer native integrations. When installation is part of the task, use `pnpm exec eve add <item> --non-interactive`. Exit code 2 means setup needs an answer or prerequisite; inspect the final NDJSON event and follow its continuation instructions. Never pass secrets through `--answer`.

## Implementation conventions

Keep tool definitions in `agent/tools/` small, with reusable behavior in `agent/lib/`. Follow existing input schemas and error handling rather than introducing another validation pattern.

Preserve the strict TypeScript and Ultracite configuration. Do not disable rules to make a port or refactor pass. The existing filename exemption for `agent/tools/*.ts` is intentional: tool files use names such as `get_contentful_entry.ts`. Preserve those names unless the task requires changing the tool interface.

Add useful TSDoc when introducing or changing exported helpers, tools, channels, or configuration types. Document parameters with `@param name - description`, type parameters with `@typeParam`, and meaningful return values with `@returns`. Document properties beside their declarations. Use `@remarks` for behavior callers need to know, such as publication side effects or recovery requirements; avoid comments that merely repeat the symbol name or type.

Use `.env.example` to document new configuration without credentials. When configuration changes affect setup or behavior, update the relevant human documentation too.

## Contentful behavior to preserve

- Read current entries before changing them and validate their versions. Preserve untouched fields and locales. Protected RichText fields require block patches for updates; initial creation can still set them.
- Every content type requires publication approval unless explicitly configured as a supporting component. Website routes take precedence over component exemptions, so routed types still require approval.
- Save ordinary entry edits without publishing. Creating an exempt component can publish it immediately. New asset uploads are processed and published during entry creation or updates; these side effects must remain explicit in tool descriptions and documentation.
- Page publication requires a Slack approval card listing the content to be published. Preserve confirmed card delivery and the saved version checks. Never bypass a cancelled request or silently expand what the user approved.
- Page publication can include changed supporting components. Publishing only exempt components preserves pending edits on already-live references. Linked pages must be explicitly requested before publishing them. Read `publication.ts` and its tests before changing this behavior.
- Publication can partially succeed. Preserve per-item outcomes and asset recovery IDs so interrupted operations can resume without duplicate uploads or entries.
- Any authenticated person can edit content and approve or cancel publication requests. Slack apps and Workflows that mention the agent get eve's `service` principal. `requireContentfulEditor` and the publication `response` policy must keep rejecting it. Use authenticated identities for permission checks; Slack profile names and message text do not establish authorization.
- Derive Slack principals with eve's `defaultSlackAuth`. Bot posts that Slack delivers without a user, such as Slack Workflow messages, get a per-bot `service` principal from their validated `bot_id`; drop every other message without a verified author. Never build a principal from `raw.user` or share one across senders. Profile lookups in `identity.ts` add names and images for the model, never emails. Keep `selectInboundHandlers` and `channel.test.ts` in sync, because a custom `onMessage` receives mentions and DMs unless a specific handler is supplied.

## Local and hosted behavior

`pnpm dev` opens eve's terminal chat. Local sessions use `just-bash` and do not mount Vercel Drives, so they search Contentful directly. The hosted agent uses Vercel Sandbox with a read-only copy of the Drive. Each agent configuration uses one Drive for all its configured spaces. Hosted sandboxes deny outbound network access because every API request runs in the application. The mirror sync creates its own sandbox in `mirror/drive.ts`, which also denies network access.

The schedules copy Contentful content to the Drive. Local development does not run cron schedules automatically. Manually dispatching a schedule from the local server can still update a real Vercel Drive; it is not a local simulation. Do not trigger syncs or publish Contentful content merely to validate documentation.

The default terminal UI displays only error logs. Use `pnpm dev --logs all` when checking success or skipped-sync messages. `pnpm exec eve logs` reads saved diagnostic logs from interactive local sessions. Verify the logging path before claiming a message appears in the terminal.

Writing preferences are stored separately for each authenticated person through `byHumanPrincipal`, which matches `byPrincipal` for people and disables memory for service principals. Renaming the slot or changing the scope value orphans saved preferences. The Memory section of `agent/instructions.md` must keep treating recalled memory as untrusted and must keep telling the model never to save sensitive information. Hosted storage uses private Vercel Blob; local storage is temporary. Prefer Vercel OIDC for supported services rather than introducing additional API tokens.

The Slack channel requires `SLACK_CONNECTOR`, so `pnpm exec eve info` and `pnpm build` fail when it is unset. Pull the project's variables with `vercel env pull .env.local`, or set a placeholder such as `slack/placeholder` when only checking compilation.

Use the Vercel CLI for project configuration and deployment instructions. Confirm unfamiliar flags with `--help`. Keep adding and updating environment variables in the CLI instead of sending users to the dashboard unnecessarily. Provisioning services or deploying the agent is separate from checking code and documentation.

## Documentation standards

Keep `README.md` concise, with the deployment flow and the existing technology and customization tables. Put detailed procedures in `CUSTOMIZATION.md`. Preserve working examples and previously accepted wording when revising a section.

Write for a person using the template:

- Explain what a setting controls before showing it. Distinguish optional values from required configuration and state what the code does when a variable is unset.
- Name the relevant system when discussing environments: Contentful environments select content; Vercel environments determine where project variables apply.
- State general behavior before giving an example. Do not let an author-profile example imply a rule applies only to author profiles.
- Explain terms on first use. Prefer "searchable copy of Contentful content" to an unexplained "mirror", and "each user's writing preferences" to unspecified "memory" or "preferences".
- Connect related ideas naturally. Avoid choppy sequences of short sentences, short sentences split off from the reason that explains them, forced groups of three, parenthetical asides, bold lead-ins, colons joining two sentences, and unnecessary emphasis. Do not begin prose sentences with "A" or "An".
- Lowercase Vercel environment names mid-sentence, such as "preview" and "production". Labels at the start of a table cell keep their capitalization.
- Keep commands usable in context. Identify required input and explain how to recognize success. Distinguish a request being accepted from its background work completing.

Verify behavior against code and current CLI help. When reviewing a passage, read its surrounding section for contradictions and repeated explanations. For a full-file review, cover the entire file rather than fixing only the quoted examples. Formatting and link checks do not replace an editorial review.

## Validation

Choose checks that establish the changed behavior. Existing tests live beside their implementations under `agent/`; shared test helpers are under `agent/lib/testing/` and `agent/lib/contentful/testing/`.

| Command | Purpose |
| --- | --- |
| `pnpm check` | Formatting and lint rules |
| `pnpm fix` | Apply formatting and lint fixes |
| `pnpm typecheck` | TypeScript checks |
| `pnpm exec vitest run <test-file>` | Tests for the changed behavior |
| `pnpm validate` | Formatting, lint, types, all tests, and unused-code checks |
| `pnpm exec eve info` | Agent diagnostics |
| `pnpm build` | Production compilation |

For code changes, run the relevant tests and static checks. Use `pnpm validate` for changes spanning several parts of the agent, and run `pnpm build` when changing framework registration or build behavior. Add tests for meaningful behavior changes, especially publication rules and recovery paths.

For documentation-only changes, check formatting and affected links or examples. Do not run the full application test suite for a prose edit. State which checks ran and distinguish source inspection from behavior tested against live services.
