# eve Agent with Python

This repository is a web chat for an eve agent with a Python backend. The agent lives in `agent/`, the Next.js app that serves the chat and the other pages lives in `apps/web/`, and the FastAPI backend lives in `apps/api/`. `vercel.ts` deploys all three as services of one Vercel project. Use Node.js 24, pnpm, and uv. The root `package.json` holds every JavaScript dependency, and `apps/web` has no `package.json` of its own. The backend's Python dependencies are in `apps/api/pyproject.toml` and `apps/api/uv.lock`.

These instructions are for agents maintaining the repository. The agent's behavior is defined in [agent/instructions.md](agent/instructions.md) and the tools under `agent/tools/`.

## Project map

| Change | Location |
| --- | --- |
| Agent identity, when to use each tool, and response style | `agent/instructions.md` |
| Model and session limits | `agent/agent.ts` |
| Tools | `agent/tools/` |
| Hooks that react to session events, such as resetting the `render_ui` guard | `agent/hooks/` |
| Backend client used by the agent's tools, and shared with the web app | `agent/lib/backend.ts` |
| Zod schemas for tasks and Python tool results, shared with the chat's cards | `agent/lib/tasks.ts` and `agent/lib/python-tools.ts` |
| Components the agent can render with `render_ui` | `agent/lib/ui-catalog.ts`, rendered by `apps/web/app/_components/ui-registry.tsx`, with sortable tables in `data-table.tsx` and link preview images from `apps/web/app/preview-image.ts` |
| HTTP channel and caller auth | `agent/channels/eve.ts` |
| Sandbox and its network policy | `agent/sandbox.ts` |
| Backend app, routers, and error handlers | `apps/api/main.py` and `apps/api/routers/` |
| Database connection and table creation | `apps/api/core/config.py` and `apps/api/core/db.py` |
| Task table and request schemas | `apps/api/models/task.py` |
| Backend tests | `apps/api/tests/` |
| Shared-password tokens, used by the agent and the web app | `apps/web/lib/password-auth.ts` |
| Access rule and checks for the web app | `apps/web/lib/auth-mode.ts`, `apps/web/proxy.ts`, and `hasAccess()` in `apps/web/lib/session.ts` |
| Sign-in and sign-out | `apps/web/app/login/` |
| Backend client for Server Components, Server Actions, and route handlers | `apps/web/lib/backend.ts` |
| Backend proxy for client components | `apps/web/app/api/backend/[[...path]]/route.ts` |
| Chat layout, composer, and session handling | `apps/web/app/_components/agent-chat.tsx` |
| Messages, tool calls, questions, and approvals | `apps/web/app/_components/agent-message.tsx` |
| Cards for task and Python tool results | `apps/web/app/_components/tool-cards.tsx` |
| Tasks, Backend, and API pages | `apps/web/app/tasks/`, `apps/web/app/backend/`, and `apps/web/app/api-docs/` |
| Header, navigation, and page metadata | `apps/web/app/layout.tsx` and `apps/web/components/nav.tsx` |
| Theme colors and global styles | `apps/web/app/globals.css` |
| Vercel services, routes, and the backend binding | `vercel.ts` |
| Python lint and format rules | `[tool.ruff]` in `apps/api/pyproject.toml` |
| Setup and customization guidance | `README.md` and `CUSTOMIZATION.md` |

`apps/web/components/ui/` and `apps/web/components/ai-elements/` are copies from the shadcn/ui and AI Elements registries, and `pnpm dlx shadcn add` overwrites them. Make template-specific changes in `apps/web/app/`, and edit these folders only to fix a defect.

## Before implementing changes

Inspect the relevant implementation first. For eve API changes, start with [the installed documentation index](node_modules/eve/docs/README.md), then read the page it identifies before authoring tools, connections, channels, skills, subagents, schedules, or deployment. Use [eve's published documentation](https://eve.dev/docs) if the installed docs are unavailable. This Next.js version differs from older releases, so read the relevant guide in `node_modules/next/dist/docs/` before changing the web app, as [apps/web/AGENTS.md](apps/web/AGENTS.md) describes. For json-render changes, read the READMEs in `node_modules/@json-render/core`, `node_modules/@json-render/react`, and `node_modules/@json-render/shadcn`. Verify other third-party APIs, including FastAPI, SQLModel, and Pydantic, against the installed package or current official documentation rather than relying on recalled signatures.

Keep discovery bounded: read the routed documentation and the files needed for the change, then implement. Follow imports or public types only when they resolve a specific unanswered question. Do not recursively scan `node_modules`, `apps/api/.venv`, or unrelated framework pages.

Content-only changes to the agent's instructions do not require framework research. Preserve the configured model unless changing it is part of the request.

For a new external integration, check the eve registry before writing one from scratch:

```sh
pnpm exec eve registry search <query> --json
pnpm exec eve registry view <item>
```

Prefer items whose `implementation` is `native`. When installation is part of the task, use `pnpm exec eve add <item> --non-interactive`. Exit code 2 means setup needs an answer or a prerequisite, so read the final NDJSON event and run its `next.command`. Never pass secrets through `--answer`.

## Implementation conventions

Match the comment density and naming of the surrounding file. Add TSDoc where it helps with types or understanding, such as exported functions, components, and props. Document parameters with `@param name - description`, meaningful return values with `@returns`, and thrown errors with `@throws`.

eve names each tool after its file, so files in `agent/tools/` use snake_case. When you add, rename, or remove a tool, update the matching section of `agent/instructions.md`, and update `CARD_RENDERERS` in `tool-cards.tsx` if the tool has a card.

Keep strict TypeScript, and change the code to satisfy it. The repository has no TypeScript linter or formatter, so follow the formatting of nearby code. Python code follows the Ruff rules in `apps/api/pyproject.toml`, with a line length of 100.

`apps/web` imports several `agent/lib/` modules through relative paths, and `agent/channels/eve.ts` imports `apps/web/lib/password-auth.ts`. Keep those boundaries intact:

- `agent/lib/tasks.ts`, `agent/lib/python-tools.ts`, and `agent/lib/ui-catalog.ts` load in the browser, so keep them free of eve runtime, backend, and Node.js imports.
- `agent/lib/backend.ts` loads in the web app's server code, so keep it free of eve runtime imports.
- `apps/web/lib/password-auth.ts` loads in the agent, so keep it free of Next.js imports.

The zod schemas in `agent/lib/tasks.ts` and `agent/lib/python-tools.ts` mirror the Pydantic response models in `apps/api/`. Change both sides together, and add or update a backend test.

Server Actions run from any route, so each one starts with `hasAccess()` from `apps/web/lib/session.ts`, validates its arguments, and returns `{ error }` instead of throwing, because Next.js hides thrown messages in production. Files marked `"use server"` may export only async functions and types, so put shared helpers in a plain module that imports `server-only`.

The web app uses Cache Components with Partial Prefetching. Pages render a static shell and await backend data inside `<Suspense>`, as `apps/web/app/tasks/page.tsx` does. Pages that export `instant = true` ask the dev overlay to flag anything that would block navigation. Code that reads the clock or the request, such as session checks, calls `connection()` first so it never runs during prerendering.

Backend routes sit at the root, with no `/api` prefix, because the binding calls the service directly. App endpoints live under `/v1`, and Python tools for the agent live under `/tools`. The backend creates missing tables on its first database request, under a Postgres advisory lock so concurrent instances don't race. Without `DATABASE_URL`, a deployment answers database requests with `503` through `DatabaseNotConfiguredError`. The `httpx2` development dependency is required by FastAPI's test client.

## Access control to preserve

- The auth order in `agent/channels/eve.ts` is `passwordAuth`, `vercelOidc()`, then `localDev()`. `passwordAuth` returns `null` when the session cookie is missing or invalid, and eve rejects requests that no check accepts.
- `apps/web/lib/password-auth.ts` signs `v1.<expiresAt>` tokens with HMAC-SHA256 keyed on `EVE_CHAT_PASSWORD`, so changing the password revokes every session. Sessions last 30 days, and comparisons run in constant time. Keep the cookie httpOnly, `SameSite=Lax`, and secure in production.
- `getAuthMode` returns `local-dev` only under `next dev` or `vercel dev` without a password. Without a password, a deployed app returns `unconfigured` and fails closed. `isAuthorized` is the single access rule that `proxy.ts` and `hasAccess()` share.
- The `proxy.ts` matcher excludes whole paths only: `/login` with its subpaths and its RSC and prefetch variants, `_next/static`, `_next/image`, `favicon.ico`, and `icon.svg`. Keep new exclusions anchored so a path such as `/logins` stays gated.
- `safeNext` in `apps/web/app/login/actions.ts` allows only same-origin paths after sign-in.
- `apps/web/app/preview-image.ts` fetches only https URLs on host names, and its `publicLookup` refuses any host that resolves to a private, loopback, link-local, or reserved address. Keep both checks for every redirect.
- The chat checks `/api/auth/status` when the agent responds with a 401, and redirects to `/login` when the web app also answers 401.

## Generated UI to preserve

- `uiSpecSchema` in `agent/lib/ui-catalog.ts` validates each element's props against its component, which the catalog's own schema doesn't. The `render_ui` tool uses it as its input schema, and the chat parses tool calls with it before rendering.
- Image props use the catalog's `httpsUrl` schema and link props use `webUrl`, and `ui-registry.tsx` checks both again before rendering. Use them for any new URL prop.
- The `render_ui` tool description lists every component's description and props, and names the components that accept children. Catalog descriptions are written for the model.
- `uiSpecSchema` also rejects a `ResultCard` that isn't a child of a `CardRow`, so result cards always render as a scrolling row.
- Every catalog component needs a renderer in `ui-registry.tsx`, which TypeScript enforces through `defineRegistry`.
- The model tends to repeat UI contents in its text reply. Three places guard against it: the Response style section of `agent/instructions.md` limits the reply to one sentence after `render_ui`, the tool description says the same, and the tool's result reminds the model that the person can already see the UI. Keep all three when changing any of them. The Tasks and Python tools sections of the instructions say the same about tool cards.
- The reply after `render_ui` must be one sentence, never empty, or the model may call `render_ui` again. `render_ui` records the turn it ran in with `lastRenderedTurn` in `agent/lib/ui-state.ts` and rejects a second call in the same turn. The hook in `agent/hooks/reset-render-guard.ts` resets the guard when the person sends a message or answers a question or approval, since eve keeps the same turn open across that input.

## Local and hosted behavior

`pnpm dev:all` starts `vercel dev --local`, which runs all three services, routes `/eve/v1/*` to the agent, and sets `BACKEND_URL`. `pnpm dev:web`, `pnpm dev:eve`, and `pnpm dev:api` run one service each, and the web app and the agent fall back to `http://127.0.0.1:8000` for the backend. `pnpm dev:eve` opens eve's terminal chat. During local development, `localDev()` accepts every agent request, and the app opens without a password when `EVE_CHAT_PASSWORD` is unset. Without `DATABASE_URL`, the backend stores tasks in `apps/api/.data/dev.sqlite3`. Local sessions use `just-bash`, which runs in process with no network isolation, and deployed sessions use Vercel Sandbox with outbound network access denied.

Don't start dev servers yourself. Ask the person to run them and report what they see.

When writing deployment instructions for people, use the Vercel CLI, including `vercel link`, `vercel env add`, `vercel env pull .env.local`, and `vercel deploy --prod`. Confirm unfamiliar flags with `--help`. Provisioning services or deploying the app is separate from checking code and documentation.

## Documentation standards

Keep `README.md` concise, with the setup flow, the technology and customization tables, and short summaries that link to `CUSTOMIZATION.md` for detailed procedures. Preserve working examples and previously accepted wording when revising a section.

Write for a person using the template:

- Name the kind of thing on first use, such as "the `EVE_CHAT_PASSWORD` environment variable" or "the `render_ui` tool", and say what it controls before showing it. State what happens when a value is unset.
- Explain terms on first use. Prefer plain descriptions to implementation terms.
- Frame guidance positively. Say what to do and what happens, such as "Deploy with `vercel deploy --prod`, which keeps your `.env.local` file as it is."
- Connect related ideas naturally, and keep introductions to the essentials. Leave out filler and stock phrases such as "seamless", "robust", and "leverage", along with em dashes, "not just X but Y", forced groups of three, parenthetical asides, bold lead-ins, colons joining two sentences, and sentences beginning with "A" or "An".
- Bold exact UI labels, such as **Tasks**. Use inline code for files, commands, identifiers, environment variables, and values.
- Lowercase Vercel environment names mid-sentence, such as "preview" and "production".
- Keep commands usable in context. Identify required input and explain how to recognize success.
- In `README.md` and `CUSTOMIZATION.md`, avoid paragraphs and list items whose last line on GitHub holds only one or two words.

Verify behavior against the code and current CLI help, and reread each section as a whole for contradictions and repetition.

## Validation

Choose checks that establish the changed behavior.

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | TypeScript checks for the agent, the web app, and `vercel.ts` |
| `pnpm test` | Backend tests with pytest |
| `pnpm lint:api` | Ruff lint and format checks for the backend |
| `pnpm build` | Production build of the agent and the web app |
| `pnpm build:eve` | Production build of the agent |
| `pnpm build:web` | Production build of the web app |

Run `pnpm typecheck` after every TypeScript change, and `pnpm test` and `pnpm lint:api` after every backend change. Run `pnpm build:web` when changing pages, Server Actions, styles, or dependencies of the web app, since some Next.js rules are checked only at build time. State which checks ran and what remains untested in a browser.
