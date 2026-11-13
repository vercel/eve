# eve Vercel Drives Starter

This repository is a reusable Slack-based assistant built on eve that reads and saves a team's files on a Vercel Drive. Each session mounts a read-only snapshot of the Drive, and writes go through a short-lived sandbox that holds the Drive's read-write mount. Use Node.js 24 and pnpm.

These instructions are for agents maintaining the repository. The assistant's behavior is defined in [agent/instructions.md](agent/instructions.md).

## Project map

| Change | Location |
| --- | --- |
| Assistant behavior and response style | `agent/instructions.md` |
| Model and session limits | `agent/agent.ts` |
| Drive name, region, mount path, path validation, and writes | `agent/lib/drive.ts` |
| Session sandbox and the Drive snapshot mount | `agent/sandbox.ts` |
| Save tool and built-in tool overrides | `agent/tools/` |
| Upload command | `scripts/upload-to-drive.ts` and `scripts/lib/upload.ts` |
| Sample files for the first upload | `content/` |
| Slack channel, sender auth, and profile lookups | `agent/channels/slack.ts` and `agent/lib/integrations/slack/` |
| HTTP channel and caller auth | `agent/channels/eve.ts` |
| Shared test fixtures | `agent/lib/testing/` |
| Setup and customization guidance | `README.md`, `CUSTOMIZATION.md`, and `.env.example` |

Keep the template focused on reading and saving Drive files. Delete tools, scheduled syncs, approval gates, and additional Drives are documented in `CUSTOMIZATION.md` and are not enabled by default.

## Before implementing changes

Inspect the relevant implementation and nearby tests. For eve API changes, start with [the installed documentation index](node_modules/eve/docs/README.md), then read the page it identifies for the task. Sandbox and mount changes usually need `node_modules/eve/docs/sandbox/vercel.mdx`. Use [eve's published documentation](https://eve.dev/docs) if the installed docs are unavailable. Verify Drive behavior against the installed `@vercel/sandbox` types and the [Vercel Drives documentation](https://vercel.com/docs/sandbox/concepts/drives) rather than relying on recalled signatures.

Keep discovery bounded: read the routed documentation and the files needed for the change, then implement. Follow imports or public types only when they resolve a specific unanswered question. Do not recursively scan dependencies or read unrelated framework pages.

Content-only changes to the assistant's instructions do not require framework research. Preserve the configured model unless changing it is part of the request.

For a new external integration, check the eve registry before writing an integration from scratch:

```sh
pnpm exec eve registry search <query> --json
pnpm exec eve registry view <item>
```

Prefer native integrations. When installation is part of the task, use `pnpm exec eve add <item> --non-interactive`. Exit code 2 means setup needs an answer or prerequisite; inspect the final NDJSON event and follow its continuation instructions. Never pass secrets through `--answer`.

## Implementation conventions

Keep files in `agent/tools/` small, with reusable behavior in `agent/lib/`. `save_to_drive.ts` is the only authored tool; the other tool files disable eve built-ins. Disabling `write_file` steers the model toward `save_to_drive`. `web_fetch` and `web_search` are removed because they run in the app outside the sandbox's network policy and would give instructions planted in Drive files a way to send file contents out. `bash` and `read_file` stay enabled for reading `/drive`. The filename exemption for `agent/tools/*.ts` in `oxlint.config.ts` exists because eve names tools after their files.

Keep `scripts/upload-to-drive.ts` limited to argument parsing and output, with upload logic in `scripts/lib/upload.ts` so tests can call it directly. Modules under `scripts/` and the modules they import from `agent/lib/` run under plain Node type stripping, so they import local files with explicit `.ts` extensions.

Preserve the strict TypeScript and Ultracite configuration. Do not disable rules to make a port or refactor pass.

Add TSDoc when introducing or changing exported helpers, tools, channels, or configuration. Document parameters with `@param name - description`, type parameters with `@typeParam`, meaningful return values with `@returns`, intentional errors with `@throws {@link ErrorType}`, and defaults with `@defaultValue`. Use `@remarks` for behavior callers need to know, such as when the Drive can be busy. Remove inline comments that repeat the code; keep those that explain a constraint the code can't express.

Use `.env.example` to document new configuration without credentials. When configuration changes affect setup or behavior, update the relevant human documentation too.

## Drive behavior to preserve

- Sessions mount the Drive only as a `snapshot`. A snapshot reflects the Drive when it's mounted, so saved files appear in new sessions. Never mount the Drive read-write in the session sandbox: only one sandbox can hold the read-write mount, so one session would block every save and upload.
- Writes go through `withWritableDrive`, which checks `currentSessionId`, rechecks it when `Sandbox.create` fails, and throws `DriveBusyError` when another sandbox holds the read-write mount. Tools return busy as a result the model can act on, such as `drive_busy`, rather than throwing. A failed `stop()` is logged, never thrown, so it can't hide a completed write.
- Resolve every model- or user-supplied path through `resolveDrivePath`, which rejects absolute paths, `.` and `..` segments, empty segments, NUL bytes, segments with leading or trailing whitespace, and segments longer than 255 bytes.
- A Drive must be written to once before it can be mounted as a snapshot, and its region can't change after creation. The sandbox environment must run in `DRIVE_REGION`. `agent/sandbox.ts` falls back to an unmounted sandbox when the mount fails, and `agent/instructions.md` explains an empty or missing `/drive` to users; keep both.
- Write sandboxes deny all network access, run with `persistent: false`, and stop when the callback settles. Session sandboxes deny all network access.
- Keep the Saving files section of `agent/instructions.md` consistent with the `save_to_drive` description and return shapes.

## Local and hosted behavior

`pnpm dev` opens eve's terminal chat. Local sessions use the same Vercel Sandbox and Drive as the deployment, so they need the Vercel OIDC token from `vercel env pull .env.local`. The token expires after 12 hours, so pull it again when the SDK reports an OIDC credentials error. Local sessions don't look up Slack profiles.

The Slack channel requires `SLACK_CONNECTOR`, so `pnpm exec eve info` and `pnpm build` fail when it is unset. Pull the project's variables with `vercel env pull .env.local`, or set a placeholder value such as `slack/placeholder` when only checking compilation. `pnpm build` also prepares a Vercel Sandbox snapshot, which needs a linked project and credentials.

Use the Vercel CLI for project configuration and deployment instructions, including `vercel deploy --prod`, `vercel env add`, and `vercel sandbox`. Confirm unfamiliar flags with `--help`. Provisioning services, uploading to a Drive, or deploying the agent is separate from checking code and documentation.

## Documentation standards

Keep `README.md` concise, with the deployment flow, the technology and customization tables, and short summaries that link to `CUSTOMIZATION.md` for detailed procedures. Preserve working examples and previously accepted wording when revising a section.

Write for a person using the template:

- Explain what a setting controls before showing it. Distinguish optional values from required configuration and state what the code does when a variable is unset.
- Explain terms on first use, such as session, snapshot, and read-write mount, and use them consistently. A session is one Slack thread or one `pnpm dev` chat.
- Lowercase Vercel environment names mid-sentence, such as "preview" and "production". Labels at the start of a table cell keep their capitalization.
- Connect related ideas naturally. Avoid choppy sequences of short sentences, short sentences split off from the reason that explains them, forced groups of three, parenthetical asides, bold lead-ins, colons joining two sentences, and unnecessary emphasis.
- Keep commands usable in context. Identify required input and explain how to recognize success.

Verify behavior against code and current CLI help. When reviewing a passage, read its surrounding section for contradictions and repeated explanations. After applying an edit, check that the revision didn't introduce new problems from the list above. Formatting and link checks do not replace an editorial review.

## Validation

Choose checks that establish the changed behavior. Tests live beside their implementations under `agent/` and `scripts/lib/`, and mock only the Vercel Sandbox and Slack APIs using the fixtures in `agent/lib/testing/`.

| Command | Purpose |
| --- | --- |
| `pnpm check` | Formatting and lint rules |
| `pnpm fix` | Apply formatting and lint fixes |
| `pnpm typecheck` | TypeScript checks |
| `pnpm exec vitest run <test-file>` | Tests for the changed behavior |
| `pnpm validate` | Formatting, lint, types, all tests, and unused-code checks |
| `pnpm exec eve info` | Agent diagnostics |
| `pnpm build` | Production compilation |

For code changes, run the relevant tests and static checks. Use `pnpm validate` for changes spanning several parts of the agent, and run `pnpm exec eve info` when changing tools, channels, the sandbox, or other framework registration. Add tests for meaningful behavior changes, especially path validation and the busy check.

For documentation-only changes, check formatting and affected links or examples. Typecheck new code samples before adding them to the docs. Do not run the full application test suite for a prose edit. State which checks ran and distinguish source inspection from behavior tested against live services.
