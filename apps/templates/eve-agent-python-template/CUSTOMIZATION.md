# Customize your chat agent

You can change the agent's behavior with files in `agent/`, the chat and the other pages with files in `apps/web/`, and the Python backend with files in `apps/api/`.

Choose the task you want to complete:

- [Change environment variables](#change-environment-variables)
- [Change writing style and model settings](#change-writing-style-and-model-settings)
- [Add or remove tools](#add-or-remove-tools)
- [Add a backend endpoint](#add-a-backend-endpoint)
- [Add a Python tool](#add-a-python-tool)
- [Show a tool's result as a card](#show-a-tools-result-as-a-card)
- [Connect another eve agent](#connect-another-eve-agent)
- [Add a component the agent can render](#add-a-component-the-agent-can-render)
- [Change who can use the app](#change-who-can-use-the-app)
- [Customize the chat interface](#customize-the-chat-interface)
- [Change how the app deploys](#change-how-the-app-deploys)
- [Control sandbox network access](#control-sandbox-network-access)
- [Remove features](#remove-features)
- [Test and deploy your changes](#test-and-deploy-your-changes)

## Change environment variables

The template reads these environment variables:

| Environment variable | What it controls |
| --- | --- |
| `EVE_CHAT_PASSWORD` | The password visitors enter on the `/login` page. Without it, the deployed app sends every visitor to a notice asking you to set it. |
| `DATABASE_URL` | The Postgres database that stores tasks. The Neon integration sets it. Without it, a deployment's task endpoints return an error that the Tasks page explains, and local development uses a SQLite file. |
| `BACKEND_URL` | The backend's private URL. The [service binding](#change-how-the-app-deploys) in `vercel.ts` sets it for the agent and the web app, so leave it unset. |

Add `EVE_CHAT_PASSWORD` to your Vercel project with `vercel env add` followed by its name:

```sh
vercel env add EVE_CHAT_PASSWORD
```

Use a long random password, such as one generated with `openssl rand -base64 32`. Sign-in attempts aren't rate limited, and the password also signs the session cookie, so a short password is easier to guess. To limit attempts, add a [Vercel Firewall rate limiting rule](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting) for `POST` requests to `/login`.

Enter the value when prompted, and choose the Vercel environments that should use it. To replace an existing value, add `--force`. Redeploy to production with `vercel deploy --prod` to apply the change.

Changing the password signs out everyone who entered the old one.

## Change writing style and model settings

### Identity and tone

[agent/instructions.md](agent/instructions.md) sets what the agent is for, when it uses each tool, and how it writes. Edit the Identity section to describe who the agent works with. For example:

```md
You help a small operations team keep track of their work. Use American English and keep answers short unless someone asks for detail. Offer to add a task when someone mentions a follow-up.
```

When you add or remove a tool, update the Tools, Tasks, or Python tools section to match. The Response style section keeps the text reply to one sentence whenever the agent shows results with `render_ui`, so keep that rule if you rewrite it.

### Model and session limits

Change `model` in [agent/agent.ts](agent/agent.ts) to use another [AI Gateway model](https://vercel.com/ai-gateway/models). The template uses `anthropic/claude-sonnet-5` and sets `limits.sessionUsage` to stop after `300_000` total input tokens in each continuation window. When someone selects **Continue** at the usage prompt, eve starts a new window. See [eve's agent configuration](https://eve.dev/docs/agent-config) for output and cost limits.

## Add or remove tools

Each file in [agent/tools/](agent/tools/) defines one tool, and eve names the tool after the file. The template includes eight:

| Tool | File | What it does |
| --- | --- | --- |
| `list_tasks` | [list_tasks.ts](agent/tools/list_tasks.ts) | Lists tasks from the backend, open tasks first |
| `create_task` | [create_task.ts](agent/tools/create_task.ts) | Adds a task |
| `update_task` | [update_task.ts](agent/tools/update_task.ts) | Renames a task, changes its notes, or marks it completed |
| `delete_task` | [delete_task.ts](agent/tools/delete_task.ts) | Deletes a task after you approve it |
| `compute_stats` | [compute_stats.ts](agent/tools/compute_stats.ts) | Computes statistics for a list of numbers in Python |
| `analyze_text` | [analyze_text.ts](agent/tools/analyze_text.ts) | Measures length, readability, and reading time of text in Python |
| `render_ui` | [render_ui.ts](agent/tools/render_ui.ts) | Shows answers as UI built from the [component catalog](#add-a-component-the-agent-can-render) |
| `ask_question` | [ask_question.ts](agent/tools/ask_question.ts) | Asks the person a question with options and waits for the answer |

To remove a tool, delete its file and remove it from `agent/instructions.md`. If the tool has a card, remove its entry from `CARD_RENDERERS` in [tool-cards.tsx](apps/web/app/_components/tool-cards.tsx).

To require approval for a tool you write, set its `approval` property to `always()` from `eve/tools/approval`, as `delete_task.ts` does. The chat shows the tool's inputs with buttons to approve or cancel the call. Use `once()` instead to stop asking after the first approval in a conversation.

The agent also has eve's default tools, including `web_search`, `web_fetch`, and `bash`. To turn one off, add a file with its name to `agent/tools/` that exports `disableTool()` from `eve/tools`:

```ts
import { disableTool } from "eve/tools";

export default disableTool();
```

For a service such as Linear or GitHub, check the eve registry before writing a tool yourself:

```sh
pnpm exec eve registry search <service>
pnpm exec eve add <item> --non-interactive
```

## Add a backend endpoint

The backend in [apps/api/](apps/api/) serves the app's data endpoints under `/v1`. The `/v1/tasks` endpoints are a complete example, from the database table to the Tasks page and the agent's task tools.

1. Add a model in `apps/api/models/`, such as `apps/api/models/note.py`, with a SQLModel class that sets `table=True` and the schemas your endpoints accept and return. Export them from `apps/api/models/__init__.py` so the backend creates the table.
2. Add a router in `apps/api/routers/` with `APIRouter(prefix="/notes")`, and take `session: SessionDep` from `core.db` in each endpoint that reads or writes the database. Then add it to the `v1` router in `apps/api/main.py` with `include_router`.
3. Add tests in `apps/api/tests/` that use the `client` fixture from `conftest.py`, which gives each test a fresh in-memory database. Run them with `pnpm test`.
4. Call the endpoint from the web app with `backendJson` from [apps/web/lib/backend.ts](apps/web/lib/backend.ts), as [apps/web/app/tasks/page.tsx](apps/web/app/tasks/page.tsx) does. Put the component that waits for the data inside `<Suspense>` with a fallback, so the page header shows while the data loads. Client components can call `fetch("/api/backend/v1/notes")`, which forwards the request to the backend for signed-in visitors.

Server Actions run from any page, so start each one with `hasAccess()` from [apps/web/lib/session.ts](apps/web/lib/session.ts), as [apps/web/app/tasks/actions.ts](apps/web/app/tasks/actions.ts) does, and validate its arguments before calling the backend.

To let the agent use the endpoint, add a tool that calls `backendRequest` from [agent/lib/backend.ts](agent/lib/backend.ts), as [create_task.ts](agent/tools/create_task.ts) does, and describe the tool in `agent/instructions.md`.

The API page lists the new endpoint on its next load. Add a `summary` to the route and `Field(description=...)` to its Pydantic fields to document it there.

The backend creates missing tables on its first database request, but it doesn't change tables that already exist. Once your schema needs to change, manage it with a migration tool such as [Alembic](https://alembic.sqlalchemy.org/).

Add Python packages with `uv add --directory apps/api <package>`, which records them in `apps/api/uv.lock` for Vercel to install.

## Add a Python tool

Python tools are endpoints under `/tools` in the backend. The agent calls each one through a tool file, as the `compute_stats` tool calls `/tools/stats`.

1. Add an endpoint to [apps/api/routers/tools.py](apps/api/routers/tools.py) with Pydantic models for its request and response.
2. Add a zod schema that matches the response model to [agent/lib/python-tools.ts](agent/lib/python-tools.ts), such as `myToolSchema`.
3. Add a tool file, such as `agent/tools/my_tool.ts`, that sends the input to the endpoint and checks the response with the schema:

   ```ts
   import { defineTool } from "eve/tools";
   import { z } from "zod";
   import { backendRequest } from "../lib/backend";
   import { myToolSchema } from "../lib/python-tools";

   export default defineTool({
     description: "What the tool does, written for the model.",
     inputSchema: z.object({ query: z.string() }),
     outputSchema: myToolSchema,
     async execute(input) {
       return myToolSchema.parse(await backendRequest("/tools/my-tool", { body: input }));
     },
   });
   ```

4. Describe when to use the tool in the Python tools section of `agent/instructions.md`, and add a test for the endpoint in `apps/api/tests/`.

## Show a tool's result as a card

The chat shows the results of the task tools and Python tools as cards from [tool-cards.tsx](apps/web/app/_components/tool-cards.tsx). Other tools, apart from `render_ui` and questions, appear as a collapsible tool call.

1. Export the tool's output schema from a module in `agent/lib/`, and use it as the tool's `outputSchema`. The chat imports these modules in the browser, so keep them free of eve runtime, backend, and Node.js imports.
2. Add an entry to `CARD_RENDERERS` in `tool-cards.tsx` that checks the output with `safeParse` and returns your card, or `undefined` to show the tool call instead.
3. In `agent/instructions.md`, say that the tool's result shows as a card, so the agent doesn't repeat it with `render_ui`. The Tasks and Python tools sections show the wording.

## Connect another eve agent

Your agent can hand questions to another deployed eve agent, which it calls like a tool. For example, deploy the [eve Data Analyst Template](https://github.com/vercel-labs/eve-data-analyst-template) and let the chat answer questions about your business data.

1. Add a file to `agent/subagents/`, such as `data_analyst.ts`, and eve names the tool after the file.

   ```ts
   import { defineRemoteAgent } from "eve";
   import { vercelOidc } from "eve/agents/auth";

   export default defineRemoteAgent({
     auth: vercelOidc(),
     description:
       "Answers questions about the business's data, such as revenue, MRR, churn, and website traffic.",
     url: "https://your-data-analyst.vercel.app",
   });
   ```

2. The data analyst accepts Vercel tokens only from its own project by default. In its `agent/channels/eve.ts`, allow this project as well:

   ```ts
   import { localDev, vercelOidc, vercelSubject } from "eve/channels/auth";
   import { eveChannel } from "eve/channels/eve";

   export default eveChannel({
     auth: [
       vercelOidc({
         subjects: [
           vercelSubject({
             teamSlug: "your-team",
             projectName: "eve-agent-python",
           }),
         ],
       }),
       localDev(),
     ],
   });
   ```

3. Give this project a database role in the data analyst's `ANALYST_ROLE_MAP`, as described in [Bots, workflows, and API callers](https://github.com/vercel-labs/eve-data-analyst-template/blob/main/CUSTOMIZATION.md#bots-workflows-and-api-callers).

4. Redeploy both projects.

See [eve's remote agents guide](https://eve.dev/docs/guides/remote-agents) to read the URL from an environment variable or to forward the person's identity.

## Add a component the agent can render

The `render_ui` tool builds answers from a catalog of components with [json-render](https://json-render.dev/). The agent writes a spec that lists elements and their props, and the chat renders the spec once every element's props are valid.

Two files define each component:

- [agent/lib/ui-catalog.ts](agent/lib/ui-catalog.ts) declares the name, description, and props that the agent reads.
- [apps/web/app/\_components/ui-registry.tsx](apps/web/app/_components/ui-registry.tsx) maps the name to the React component that renders it.

To add a component, such as a star rating:

1. Add an entry to `components` in `agent/lib/ui-catalog.ts`. Write the description for the model, saying what the component shows and when to use it. Make optional props `.nullable()`, as the other components do.

   ```ts
   Rating: {
     description: "A star rating out of 5, with an optional review count.",
     props: z.object({
       reviews: z.number().nullable(),
       value: z.number().min(0).max(5),
     }),
   },
   ```

2. Add a matching entry to `components` in `apps/web/app/_components/ui-registry.tsx`. TypeScript reports an error until every catalog component has a renderer.

   ```tsx
   Rating: ({ props }) => (
     <p className="text-sm">
       {props.value.toFixed(1)} / 5
       {props.reviews === null ? null : ` (${props.reviews} reviews)`}
     </p>
   ),
   ```

3. Run `pnpm typecheck` to confirm the two files match.

To accept child elements, as `CardRow` does, add `slots: ["default"]` to the catalog entry and render `children` in the component. For image and link props, use the `httpsUrl` and `webUrl` schemas in the catalog, which accept only absolute web addresses, so the agent can't render a `javascript:` link or load an image from a `data:` URL or a plain `http:` address.

The catalog combines components from `@json-render/shadcn`, such as `Accordion` and `Alert`, with components written for this template, such as `ResultCard`, `Metric`, and `Steps`. To add another shadcn component from json-render, add `shadcnComponentDefinitions.<Name>` to the catalog and `shadcnComponents.<Name>` to the registry. To restyle one, replace its registry entry with your own component, as the template does for `Heading`, `Text`, and `Table`, which sorts by column with TanStack Table.

## Change who can use the app

The agent and the web app check the same session cookie, which the `/login` page sets after a visitor enters the password in `EVE_CHAT_PASSWORD`.

[agent/channels/eve.ts](agent/channels/eve.ts) lists the checks the agent runs on each request, in order:

1. `passwordAuth` accepts browsers with a valid session cookie.
2. `vercelOidc()` accepts Vercel OIDC tokens from this project, such as calls between its services.
3. `localDev()` accepts every request during local development.

The agent rejects every other request. In the web app, [apps/web/proxy.ts](apps/web/proxy.ts) sends visitors without a valid cookie to `/login`, and answers `401` for `/api/*` requests. `isAuthorized` in [apps/web/lib/auth-mode.ts](apps/web/lib/auth-mode.ts) holds the rule, and Server Actions apply it again through `hasAccess()` in [apps/web/lib/session.ts](apps/web/lib/session.ts).

Everyone who signs in with the password is trusted equally and shares one identity. Anyone signed in can open a chat from its link and change any task, so to keep each person's chats and tasks private, [use your own sign-in](#use-your-own-sign-in) and check who owns each session, as [eve's multi-tenant auth guide](https://eve.dev/docs/patterns/multi-tenant-auth) describes.

### Use your own sign-in

To give each person their own account, use an auth provider such as Clerk or Better Auth:

1. Write a function that verifies your provider's session from the request, following [eve's authentication guide](https://eve.dev/docs/guides/auth-and-route-protection). Replace `passwordAuth` in `agent/channels/eve.ts` with it.
2. Replace `isAuthorized` in `apps/web/lib/auth-mode.ts`, the cookie check in `apps/web/proxy.ts`, and the helpers in `apps/web/lib/session.ts` with your provider's session check. Replace the `apps/web/app/login/` page with its sign-in page, and the **Sign Out** button in `apps/web/app/layout.tsx` with its sign-out flow.
3. Add an owner column to `Task` in `apps/api/models/task.py`, pass the signed-in person's ID from the web app and the agent to the backend, and filter task queries by it in `apps/api/routers/tasks.py`. The backend doesn't change existing tables, so add the column to a deployed database with a [migration](#add-a-backend-endpoint).
4. Remove `apps/web/lib/password-auth.ts` and the `EVE_CHAT_PASSWORD` environment variable.

### Make the app public

In `agent/channels/eve.ts`, remove `passwordAuth` and add `none()` from `eve/channels/auth` as the last check. Then make `isAuthorized` in `apps/web/lib/auth-mode.ts` return `true`. Anyone with the URL can then chat with the agent, change the shared tasks, and spend your AI Gateway credits, so keep the session limits in `agent/agent.ts` in place.

## Customize the chat interface

| Change | Location |
| --- | --- |
| Agent name on the home page | `AGENT_NAME` in [agent-chat.tsx](apps/web/app/_components/agent-chat.tsx) |
| Page titles and description, and the logo's label | `metadata` in [layout.tsx](apps/web/app/layout.tsx) and each page, and the logo link in `layout.tsx` |
| Header links to the **Chat**, **Tasks**, **Backend**, and **API** pages | `links` in [nav.tsx](apps/web/components/nav.tsx) |
| Logo | [logo-mark.tsx](apps/web/components/logo-mark.tsx) and [icon.svg](apps/web/app/icon.svg) |
| Messages, tool calls, questions, and approvals | [agent-message.tsx](apps/web/app/_components/agent-message.tsx) |
| Cards for task and Python tool results | [tool-cards.tsx](apps/web/app/_components/tool-cards.tsx) |
| Tasks page | [apps/web/app/tasks/](apps/web/app/tasks/) |
| Sign-in page | [apps/web/app/login/](apps/web/app/login/) |
| Colors for light and dark mode, including the `--success`, `--info`, and `--warning` status colors on cards | [globals.css](apps/web/app/globals.css) |

To add a shadcn/ui component, run the shadcn CLI with `-c apps/web`. The web app has no `package.json` of its own, so check that any dependency the component needs lands in the root `package.json`:

```sh
pnpm dlx shadcn@latest add <component> -c apps/web
```

## Change how the app deploys

[vercel.ts](vercel.ts) configures the project's [Vercel Services](https://vercel.com/docs/services). It declares the `web` service, which builds the Next.js app in `apps/web`, and the `api` service, which runs the FastAPI app in `apps/api` with a 60-second limit per request. One route sends every request to `web`. `withEve` from `eve/vercel` adds the agent as a third service, with a route that sends `/eve/v1/*` requests to the agent before they reach the web app.

No route points at `api`, so the internet can't reach the backend directly. Signed-in visitors reach it only through the web app's `/api/backend` proxy, and a service binding gives `web` and the agent the backend's URL in the `BACKEND_URL` environment variable. Requests through the binding stay inside the deployment, so a preview deployment calls its own backend.

To add a service of your own, add it to `services`. To make it public, put its route before the route that sends every request to `web`. To let other services call it privately, add a binding like `backendBinding` instead.

## Control sandbox network access

When deployed, [agent/sandbox.ts](agent/sandbox.ts) opens a Vercel Sandbox with all outbound network access denied, so commands the agent runs can't send data anywhere. The `web_fetch` tool runs outside the sandbox and `web_search` runs through the model provider, so both keep working. Local sessions use `just-bash` instead, which runs in process without network isolation.

To let deployed commands reach specific hosts, replace `"deny-all"` with a list of allowed hosts:

```ts
environment.open({ networkPolicy: { allow: { "api.github.com": [] } } });
```

See [eve's Vercel Sandbox documentation](https://eve.dev/docs/sandbox/vercel) for the other options.

## Remove features

| Feature | Files to remove or change |
| --- | --- |
| Tasks | Remove the four task tools in `agent/tools/`, `agent/lib/tasks.ts`, `apps/web/app/tasks/`, `apps/api/routers/tasks.py`, `apps/api/models/task.py`, and `apps/api/tests/test_tasks.py`. Then remove the task router from `apps/api/main.py`, the task models from `apps/api/models/__init__.py`, the `Task` export from `apps/web/lib/backend.ts`, the task cards and their imports from `tool-cards.tsx`, the Tasks section of `agent/instructions.md`, and the Tasks link in `nav.tsx` |
| Python tools | Remove `agent/tools/compute_stats.ts`, `agent/tools/analyze_text.ts`, `agent/lib/python-tools.ts`, `apps/api/routers/tools.py`, and `apps/web/components/stats-form.tsx`. Then remove the tools router from `apps/api/main.py`, the `/tools` tests from `apps/api/tests/test_api.py`, the statistics cards and their imports from `tool-cards.tsx`, the Python tools section of `agent/instructions.md`, and the statistics card on the Backend page |
| Questions | Remove `agent/tools/ask_question.ts` |
| Web search and fetching | Add `agent/tools/web_search.ts` and `agent/tools/web_fetch.ts`, each exporting `disableTool()` |
| Sandbox tools | Add `agent/tools/bash.ts`, `agent/tools/read_file.ts`, and `agent/tools/write_file.ts`, each exporting `disableTool()` |
| Password | Follow [Use your own sign-in](#use-your-own-sign-in) or [Make the app public](#make-the-app-public) |

## Test and deploy your changes

Run these checks before deploying:

```sh
pnpm typecheck
pnpm test
pnpm lint:api
pnpm build
```

`pnpm typecheck` checks the types of the agent and the web app, and `pnpm build` builds both. `pnpm test` runs the backend's tests with pytest, and `pnpm lint:api` checks the backend's Python code with Ruff.

To try a change, run `pnpm dev:all` and open the URL it prints. When the checks pass, deploy to production with `vercel deploy --prod`.
