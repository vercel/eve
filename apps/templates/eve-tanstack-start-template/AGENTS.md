# eve TanStack Start

This repository is a reusable web chat for an eve agent. The agent lives in `agent/`, and the TanStack Start app that serves the chat lives in `apps/web/`. `vercel.ts` deploys both as services of one Vercel project. Use Node.js 24 and pnpm. The root `package.json` holds every dependency, and `apps/web` is a pnpm workspace package with none of its own.

These instructions are for agents maintaining the repository. The agent's behavior is defined in [agent/instructions.md](agent/instructions.md) and the tools under `agent/tools/`.

## Project map

| Change | Location |
| --- | --- |
| Agent identity, when to use each tool, and response style | `agent/instructions.md` |
| Model and session limits | `agent/agent.ts` |
| Tools | `agent/tools/` |
| Hooks that react to session events, such as resetting the `render_ui` guard | `agent/hooks/` |
| Components the agent can render with `render_ui` | `agent/lib/ui-catalog.ts`, rendered by `apps/web/app/_components/ui-registry.tsx`, with sortable tables in `data-table.tsx` and link preview images from `apps/web/app/preview-image.ts` |
| HTTP channel and caller auth | `agent/channels/eve.ts` |
| Shared-password tokens, used by the agent and the web app | `agent/lib/access.ts` |
| Sandbox and its network policy | `agent/sandbox.ts` |
| Access checks and sign-in for the web app | `apps/web/app/access.ts`, the `beforeLoad` check in `apps/web/app/routes/__root.tsx`, and `apps/web/app/routes/login.tsx` |
| Chat layout, composer, header, home page, and keyboard shortcuts | `apps/web/app/_components/agent-chat.tsx` |
| Messages, tool cards, questions, approvals, and authorization prompts | `apps/web/app/_components/agent-message.tsx` |
| Routes | `apps/web/app/routes/` |
| Theme colors and global styles | `apps/web/app/globals.css` |
| `vercel dev` routing fix | `apps/web/app/start.ts` |
| Vercel services and routes | `vercel.ts` |
| Lint and format rules | `oxlint.config.ts` and `oxfmt.config.ts` |
| Unused-code checks | `knip.json` |
| Setup and customization guidance | `README.md` and `CUSTOMIZATION.md` |

`apps/web/components/ui/` and `apps/web/components/ai-elements/` are copies from the shadcn/ui and AI Elements registries. `pnpm dlx shadcn add` overwrites them, and lint ignores them. Make template-specific changes in `apps/web/app/`, and edit these folders only to fix a defect.

## Before implementing changes

Inspect the relevant implementation first. For eve API changes, start with [the installed documentation index](node_modules/eve/docs/README.md), then read the page it identifies before authoring tools, connections, channels, skills, subagents, schedules, or deployment. Use [eve's published documentation](https://eve.dev/docs) if the installed docs are unavailable. For json-render changes, read the READMEs in `node_modules/@json-render/core`, `node_modules/@json-render/react`, and `node_modules/@json-render/shadcn`. Verify other third-party APIs against the installed package or current official documentation rather than relying on recalled signatures.

Keep discovery bounded: read the routed documentation and the files needed for the change, then implement. Follow imports or public types only when they resolve a specific unanswered question. Do not recursively scan `node_modules` or read unrelated framework pages.

Content-only changes to the agent's instructions do not require framework research. Preserve the configured model unless changing it is part of the request.

For a new external integration, check the eve registry before writing one from scratch:

```sh
pnpm exec eve registry search <query> --json
pnpm exec eve registry view <item>
```

Prefer items whose `implementation` is `native`. When installation is part of the task, use `pnpm exec eve add <item> --non-interactive`. Exit code 2 means setup needs an answer or a prerequisite, so read the final NDJSON event and run its `next.command`. Never pass secrets through `--answer`.

Use eve for the Vercel operations you run, such as `pnpm exec eve link --non-interactive --project <name-or-id>` and `pnpm exec eve deploy --non-interactive --yes`. When a completed setup event has `deploymentRequired: true`, run the `next` command it reports.

## Implementation conventions

Write no inline code comments. Add TSDoc only where it helps with types or understanding, such as exported functions, components, constants, and props. Document parameters with `@param name - description`, meaningful return values with `@returns`, and thrown errors with `@throws`. TSDoc can't document destructured props as `@param props.name`, so write `@param props - The component props.` and add TSDoc to each field of the props type.

eve names each tool after its file, so files in `agent/tools/` use snake_case. The `unicorn/filename-case` exemption for `agent/tools/**` in `oxlint.config.ts` exists for that reason.

Keep the strict TypeScript and Ultracite configuration, and change the code to satisfy its rules. The configuration makes these exceptions:

- `func-style`, `no-use-before-define`, and `react/function-component-definition` are off, so modules use top-down `function` declarations.
- `shadcn/no-restyle` contracts allow spacing and typography on the questionnaire components used for question cards.
- `typescript/only-throw-error` allows throwing a `Response`, which TanStack Router's `throw redirect(...)` does.

Add a new exception only when the code can't reasonably satisfy the rule, and scope it to the files that need it.

`knip.json` sets the entry points for the agent and the web app, and ignores the generated route tree and the registry copies. Knip can't read CSS imports, so a package imported only from CSS, such as the Geist fonts and `tw-animate-css`, goes in its `ignoreDependencies`.

`apps/web` imports `agent/lib/access.ts` and `agent/lib/ui-catalog.ts` through relative paths. Keep both modules free of React and browser APIs.

When you add, rename, or remove a tool, update the Tools section of `agent/instructions.md` to match.

When the shadcn CLI adds a component, it may write dependencies to `apps/web/package.json`. Move any needed dependency to the root `package.json`, restore `apps/web/package.json` to its `name`, `private`, and `type` fields, and run `pnpm install`.

## Access control to preserve

- The auth order in `agent/channels/eve.ts` is `vercelOidc()`, `localDev()`, `accessCookieAuth()`, then `placeholderAuth()`. `accessCookieAuth()` returns `null` when `EVE_ACCESS_PASSWORD` is unset, so `placeholderAuth()` reports the missing configuration. It throws `UnauthenticatedError` with code `access_required` for a missing, invalid, or cross-site cookie.
- `agent/lib/access.ts` derives the signing key from the password, signs HS256 tokens with a `visitor:<uuid>` subject, and compares passwords in constant time. Keep the cookie httpOnly, `SameSite=Lax`, and secure outside development.
- `getAccessStatus` returns `open` only in development without a password. Production without a password returns `unconfigured`.
- `safeRedirect` allows only same-origin paths after sign-in.
- The chat redirects to `/login` when the agent responds with a 401, through `useSignInRedirect` in `agent-chat.tsx`.

## Generated UI to preserve

- `uiSpecSchema` in `agent/lib/ui-catalog.ts` validates each element's props against its component, which the catalog's own schema doesn't. The `render_ui` tool uses it as its input schema, and the chat parses tool calls with it before rendering.
- The `render_ui` tool description lists every component's description and props, and names the components that accept children. Catalog descriptions are written for the model.
- `uiSpecSchema` also rejects a `ResultCard` that isn't a child of a `CardRow`, so result cards always render as a scrolling row.
- Every catalog component needs a renderer in `ui-registry.tsx`, which TypeScript enforces through `defineRegistry`.
- The model tends to repeat UI contents in its text reply. Three places guard against it: the Response style section of `agent/instructions.md` limits the reply to one sentence when `render_ui` runs, the tool description says the same, and the tool's result reminds the model that the person can already see the UI. Keep all three when changing any of them.
- The reply after `render_ui` must be one sentence, never empty, or the model may call `render_ui` again. `render_ui` records the turn it ran in with `lastRenderedTurn` in `agent/lib/ui-state.ts` and rejects a second call in the same turn. The hook in `agent/hooks/reset-render-guard.ts` resets the guard when the person sends a message or answers a question or approval, since eve keeps the same turn open across that input.

## Local and hosted behavior

`pnpm dev:app` starts `vercel dev`, which runs both services and routes `/eve/v1/*` to the agent. `pnpm dev:agent` opens eve's terminal chat. During local development, `localDev()` accepts every request, and the chat opens without a password when `EVE_ACCESS_PASSWORD` is unset. Local sessions use `just-bash`, which runs in process with no network isolation, and deployed sessions use Vercel Sandbox with outbound network access denied.

Don't start dev servers yourself. Ask the person to run them and report what they see.

When writing deployment instructions for people, use the Vercel CLI, including `vercel link`, `vercel env add`, `vercel env pull .env.local`, and `vercel deploy --prod`. Confirm unfamiliar flags with `--help`. Provisioning services or deploying the agent is separate from checking code and documentation.

## Documentation standards

Keep `README.md` concise, with the setup flow, the technology and customization tables, and short summaries that link to `CUSTOMIZATION.md` for detailed procedures. Preserve working examples and previously accepted wording when revising a section.

Write for a person using the template:

- Name the kind of thing on first use, such as "the `EVE_ACCESS_PASSWORD` environment variable" or "the `render_ui` tool", and say what it controls before showing it. State what happens when a value is unset.
- Explain terms on first use. Prefer plain descriptions to implementation terms.
- Frame guidance positively. Say what to do and what happens, such as "Deploy with `vercel deploy --prod`, which keeps your `.env.local` file as it is."
- Connect related ideas naturally, and keep introductions to the essentials. Leave out filler and stock phrases such as "seamless", "robust", and "leverage", along with em dashes, "not just X but Y", forced groups of three, parenthetical asides, bold lead-ins, colons joining two sentences, and sentences beginning with "A" or "An".
- Bold exact UI labels, such as **New chat**. Use inline code for files, commands, identifiers, environment variables, and values.
- Lowercase Vercel environment names mid-sentence, such as "preview" and "production".
- Keep commands usable in context. Identify required input and explain how to recognize success.

Verify behavior against the code and current CLI help, and reread each section as a whole for contradictions and repetition.

## Validation

Choose checks that establish the changed behavior.

| Command | Purpose |
| --- | --- |
| `pnpm check` | Formatting and lint rules |
| `pnpm fix` | Apply formatting and lint fixes |
| `pnpm typecheck` | TypeScript checks for the agent and the web app |
| `pnpm build` | Production build of the agent and the web app, which needs an AI Gateway credential |
| `pnpm build:agent` | Production build of the agent, which needs an AI Gateway credential |
| `pnpm build:web` | Production build of the web app |
| `pnpm knip` | Unused files, exports, and dependencies |
| `pnpm validate` | Formatting, lint, types, and unused-code checks |

Run `pnpm validate` after every code change. Run `pnpm build:web` when changing styles, routes, or dependencies of the web app. For documentation-only changes, run `pnpm check`, which also checks Markdown formatting, and apply fixes with `pnpm fix`. State which checks ran and what remains untested in a browser.
