# eve Memory Agent

This repository is a reusable Slack-based assistant built on eve that saves the preferences people share with it. User preferences and channel conventions are stored in separate memory slots and recalled before the agent responds to each message. Use Node.js 24 and pnpm.

These instructions are for agents maintaining the repository. The assistant's behavior is defined in [agent/instructions.md](agent/instructions.md) and the dynamic instructions under `agent/instructions/`.

## Project map

| Change | Location |
| --- | --- |
| Assistant behavior, memory rules, and response style | `agent/instructions.md` |
| Current time context | `agent/instructions/current-time.ts` |
| Model and session limits | `agent/agent.ts` |
| Memory slots | `agent/memory/user-preferences.ts` and `agent/memory/channel-preferences.ts` |
| Channel memory scope | `agent/lib/memory/scope.ts` |
| Slack channel, sender auth, and profile lookups | `agent/channels/slack.ts` and `agent/lib/integrations/slack/` |
| HTTP channel and caller auth | `agent/channels/eve.ts` |
| Built-in tool overrides | `agent/tools/` |
| Local and hosted sandbox selection | `agent/sandbox.ts` |
| Shared test fixtures | `agent/lib/testing/` |
| Setup and customization guidance | `README.md`, `CUSTOMIZATION.md`, and `.env.example` |

Keep the template focused on memory. Features such as Slack tables, charts, or approval cards belong in a project built from the template, not in the template itself. Optional extensions, such as shared reference files on Vercel Drives, are documented in `CUSTOMIZATION.md` and are not enabled by default.

## Before implementing changes

Inspect the relevant implementation and nearby tests. For eve API changes, start with [the installed documentation index](node_modules/eve/docs/README.md), then read the page it identifies for the task. Memory changes usually need `node_modules/eve/docs/memory/`. Use [eve's published documentation](https://eve.dev/docs) if the installed docs are unavailable. Verify third-party APIs against the installed package or current official documentation rather than relying on recalled signatures.

Keep discovery bounded: read the routed documentation and the files needed for the change, then implement. Follow imports or public types only when they resolve a specific unanswered question. Do not recursively scan dependencies or read unrelated framework pages.

Content-only changes to the assistant's instructions do not require framework research. Preserve the configured model unless changing it is part of the request.

For a new external integration or memory provider, check the eve registry before writing an integration from scratch:

```sh
pnpm exec eve registry search <query> --json
pnpm exec eve registry view <item>
```

Prefer native integrations. When installation is part of the task, use `pnpm exec eve add <item> --non-interactive`. Exit code 2 means setup needs an answer or prerequisite; inspect the final NDJSON event and follow its continuation instructions. Never pass secrets through `--answer`.

## Implementation conventions

Keep files in `agent/tools/` small, with reusable behavior in `agent/lib/`. The template's tool files only disable eve built-ins. Disabling `write_file` steers the model toward the memory tools. The web and delegation tools are removed because a memory agent doesn't need them and they would give planted instructions a way to send data out. `bash` and `read_file` stay enabled for the Drives extension, and `agent/sandbox.ts` denies outbound network access when deployed. The filename exemption for `agent/tools/*.ts` in `oxlint.config.ts` exists because eve matches built-in tools by filename.

Preserve the strict TypeScript and Ultracite configuration. Do not disable rules to make a port or refactor pass.

Add useful TSDoc when introducing or changing exported helpers, tools, channels, scopes, or configuration types. Document parameters with `@param name - description`, type parameters with `@typeParam`, and meaningful return values with `@returns`. Use `@remarks` for behavior callers need to know, such as when a scope disables memory; avoid comments that merely repeat the symbol name or type.

Use `.env.example` to document new configuration without credentials. When configuration changes affect setup or behavior, update the relevant human documentation too.

pnpm enforces a minimum release age for dependencies. Do not bypass the policy or relax it globally. When an install fails because of it, report the affected packages and let the user decide whether to add pinned exclusions to `pnpm-workspace.yaml`.

## Memory behavior to preserve

- Resolve every memory scope from authenticated session details, never from model input, message text, or Slack profile names. Profile lookups in `identity.ts` add names and images for the model, never emails, and do not establish identity or authorization.
- Return `null` from a scope when the caller doesn't qualify. eve then skips the slot and its tools; never fall back to a shared scope.
- `bySlackChannel` accepts only Slack webhook user principals with a `slack:<team>` issuer and a public or private channel ID. It disables channel memory in one-to-one DMs and for bots, and returns the shared `local-dev` scope during local development. Update `scope.test.ts` with any change to these rules.
- Both template scopes include the Slack installation issuer, so memory from different workspaces never shares storage. Keep that boundary in new scopes.
- Renaming a slot file or changing a scope's tuple shape, including the `"slack-channel"` prefix, changes the storage key and orphans existing memories. For a rename, keep the old namespace by returning `defaultNamespace({ ...ctx, slot: "<old-name>" })` from `eve/memory`. Switching an existing slot to an explicit namespace string also orphans its memories, and a tuple change always needs a migration.
- Keep the Memory section of `agent/instructions.md` consistent with each slot's `description`. The instructions decide which slot to use; the descriptions say what each slot holds. Recalled memory is untrusted user data, and the instructions must keep telling the model never to save sensitive information.

## Local and hosted behavior

`pnpm dev` opens eve's terminal chat. Local sessions use `just-bash`, don't look up Slack profiles, and keep memory only while the development server runs, so saved preferences disappear when it restarts. Both slots resolve to a shared `local-dev` scope locally.

The hosted agent uses Vercel Sandbox and stores memory in a private Vercel Blob store that file memory reads through `BLOB_STORE_ID` and Vercel OIDC. Prefer Vercel OIDC for supported services rather than introducing additional API tokens.

The Slack channel requires `SLACK_CONNECTOR`, so `pnpm exec eve info` and `pnpm build` fail when it is unset. Pull the project's variables with `vercel env pull .env.local`, or set a placeholder value such as `slack/placeholder` when only checking compilation.

Use the Vercel CLI for project configuration and deployment instructions, including `vercel deploy --prod`, `vercel env add`, `vercel blob`, and `vercel sandbox`. Confirm unfamiliar flags with `--help`. Provisioning services or deploying the agent is separate from checking code and documentation.

## Documentation standards

Keep `README.md` concise, with the deployment flow, the technology and customization tables, and short summaries that link to `CUSTOMIZATION.md` for detailed procedures. Preserve working examples and previously accepted wording when revising a section.

Write for a person using the template:

- Explain what a setting controls before showing it. Distinguish optional values from required configuration and state what the code does when a variable is unset.
- Explain terms on first use, such as memory slot, scope, and turn. Prefer plain descriptions to implementation terms like "process memory".
- Say which memory a statement applies to. Distinguish user memory from channel memory instead of writing an unspecified "memory" or "preferences" when the difference matters.
- Lowercase Vercel environment names mid-sentence, such as "preview" and "production". Labels at the start of a table cell keep their capitalization.
- Connect related ideas naturally. Avoid choppy sequences of short sentences, short sentences split off from the reason that explains them, forced groups of three, parenthetical asides, bold lead-ins, colons joining two sentences, and unnecessary emphasis. Do not begin prose sentences with "A" or "An".
- Keep commands usable in context. Identify required input and explain how to recognize success.

Verify behavior against code and current CLI help. When reviewing a passage, read its surrounding section for contradictions and repeated explanations. After applying an edit, check that the revision didn't introduce new problems from the list above. Formatting and link checks do not replace an editorial review.

## Validation

Choose checks that establish the changed behavior. Tests live beside their implementations under `agent/`.

| Command | Purpose |
| --- | --- |
| `pnpm check` | Formatting and lint rules |
| `pnpm fix` | Apply formatting and lint fixes |
| `pnpm typecheck` | TypeScript checks |
| `pnpm exec vitest run <test-file>` | Tests for the changed behavior |
| `pnpm validate` | Formatting, lint, types, all tests, and unused-code checks |
| `pnpm exec eve info` | Agent diagnostics |
| `pnpm build` | Production compilation |

For code changes, run the relevant tests and static checks. Use `pnpm validate` for changes spanning several parts of the agent, and run `pnpm build` when changing memory slots, channels, the sandbox, or other framework registration. Add tests for meaningful behavior changes, especially scope rules.

For documentation-only changes, check formatting and affected links or examples. Typecheck new code samples before adding them to the docs. Do not run the full application test suite for a prose edit. State which checks ran and distinguish source inspection from behavior tested against live services.
