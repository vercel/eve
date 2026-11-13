# Customize your chat agent

You can change the agent's behavior with files in `agent/`, and the chat interface with files in `apps/web/`.

Choose the task you want to complete:

- [Change environment variables](#change-environment-variables)
- [Change writing style and model settings](#change-writing-style-and-model-settings)
- [Add or remove tools](#add-or-remove-tools)
- [Connect another eve agent](#connect-another-eve-agent)
- [Add a component the agent can render](#add-a-component-the-agent-can-render)
- [Change who can use the chat](#change-who-can-use-the-chat)
- [Customize the chat interface](#customize-the-chat-interface)
- [Change how the app deploys](#change-how-the-app-deploys)
- [Control sandbox network access](#control-sandbox-network-access)
- [Remove features](#remove-features)
- [Test and deploy your changes](#test-and-deploy-your-changes)

## Change environment variables

The template has one environment variable of its own. `EVE_ACCESS_PASSWORD` sets the password visitors enter on the `/login` page. Without it, the deployed chat sends every visitor to a notice asking you to set it.

Add it to your Vercel project with `vercel env add` followed by its name:

```sh
vercel env add EVE_ACCESS_PASSWORD
```

Use a long random password, such as one generated with `openssl rand -base64 32`. Sign-in attempts aren't rate limited, and the password also signs the access cookie, so a short password is easier to guess.

Enter the value when prompted, and choose the Vercel environments that should use it. To replace an existing value, add `--force`. Redeploy to production with `vercel deploy --prod` to apply the change.

Changing the password signs out everyone who entered the old one.

## Change writing style and model settings

### Identity and tone

[agent/instructions.md](agent/instructions.md) sets what the agent is for, when it uses each tool, and how it writes. Edit the Identity section to describe who the agent works with. For example:

```md
You help a travel team plan trips. Use American English and keep answers short unless someone asks for detail. Show options as result cards when you find them.
```

When you add or remove a tool, update the Tools section to match. The Response style section keeps the text reply to one sentence whenever the agent shows results with `render_ui`, so keep that rule if you rewrite it.

### Model and session limits

Change `model` in [agent/agent.ts](agent/agent.ts) to use another [AI Gateway model](https://vercel.com/ai-gateway/models). The template uses `openai/gpt-6.1-sol-fast` and limits each conversation to `300_000` input tokens through `maxInputTokensPerSession`. See [eve's agent configuration](https://eve.dev/docs/agent-config) for output and cost limits.

## Add or remove tools

Each file in [agent/tools/](agent/tools/) defines one tool, and eve names the tool after the file. The template includes three:

| Tool | File | What it does |
| --- | --- | --- |
| `render_ui` | [render_ui.ts](agent/tools/render_ui.ts) | Shows answers as UI built from the [component catalog](#add-a-component-the-agent-can-render) |
| `ask_question` | [ask_question.ts](agent/tools/ask_question.ts) | Asks the person a question with options and waits for the answer |
| `approval_demo` | [approval_demo.ts](agent/tools/approval_demo.ts) | Asks for your approval before it runs |

To remove a tool, delete its file.

To require approval for a tool you write, set its `approval` property to `always()` from `eve/tools/approval`, as `approval_demo.ts` does. The chat shows the tool's inputs with **Approve** and **Cancel** buttons. Use `once()` instead to ask only the first time the tool runs.

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

## Connect another eve agent

Your agent can hand questions to another deployed eve agent, which it calls like a tool. For example, deploy the [eve Data Analyst Template](https://github.com/vercel-labs/eve-data-analyst-template) and let the chat answer questions about your business data.

1. Add a file to `agent/subagents/`, such as `agent/subagents/data_analyst.ts`. eve names the tool after the file.

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
             projectName: "eve-tanstack-start",
           }),
         ],
       }),
       localDev(),
     ],
   });
   ```

3. Give this project a database role in the data analyst's `ANALYST_ROLE_MAP`, as described in [Bots, workflows, and API callers](https://github.com/vercel-labs/eve-data-analyst-template/blob/main/CUSTOMIZATION.md#bots-workflows-and-api-callers).

4. Redeploy both projects.

See [eve's remote agents guide](https://eve.dev/docs/guides/remote-agents) to read the URL from an environment variable or forward the person's identity to the remote agent.

## Add a component the agent can render

The `render_ui` tool builds answers from a catalog of components with [json-render](https://json-render.dev/). The agent writes a spec that lists elements and their props, and the chat renders the spec once every element's props are valid.

Two files define each component:

- [agent/lib/ui-catalog.ts](agent/lib/ui-catalog.ts) declares its name, description, and props. The agent reads these in the tool's description.
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

To accept child elements, as `CardRow` does, add `slots: ["default"]` to the catalog entry and render `children` in the component.

The catalog combines components from `@json-render/shadcn`, such as `Table` and `Alert`, with components written for this template, such as `ResultCard`, `Metric`, and `Steps`. To add another shadcn component from json-render, add `shadcnComponentDefinitions.<Name>` to the catalog and `shadcnComponents.<Name>` to the registry. To restyle one, replace its registry entry with your own component, as the template does for `Heading`, `Text`, `Progress`, and `Table`, which sorts by column with TanStack Table.

## Change who can use the chat

[agent/channels/eve.ts](agent/channels/eve.ts) lists the checks the agent runs on each request, in order:

1. `vercelOidc()` accepts requests that carry a Vercel OIDC token, such as calls from your other Vercel deployments.
2. `localDev()` accepts every request during local development.
3. `accessCookieAuth()` accepts browsers that signed in with `EVE_ACCESS_PASSWORD`.
4. `placeholderAuth()` rejects browser requests in production when no password is set.

The chat checks the same cookie before it shows a page. `getAccessStatus` in [apps/web/app/access.ts](apps/web/app/access.ts) decides whether a visitor may chat, and the `beforeLoad` check in [apps/web/app/routes/\_\_root.tsx](apps/web/app/routes/__root.tsx) sends everyone else to `/login`.

Everyone who signs in with the password is trusted equally. Anyone signed in can open a chat from its link, so to keep each person's chats private, [use your own sign-in](#use-your-own-sign-in) and check who owns each session, as [eve's multi-tenant auth guide](https://eve.dev/docs/patterns/multi-tenant-auth) describes.

### Use your own sign-in

To give each person their own account, use an auth provider such as Clerk or Better Auth:

1. Write a function that verifies your provider's session from the request, following [eve's authentication guide](https://eve.dev/docs/guides/auth-and-route-protection). Replace `accessCookieAuth()` and `placeholderAuth()` in `agent/channels/eve.ts` with it.
2. Replace `getAccessStatus` in `apps/web/app/access.ts` with your provider's session check, and replace `apps/web/app/routes/login.tsx` with its sign-in page.
3. Remove `agent/lib/access.ts` and the `EVE_ACCESS_PASSWORD` environment variable.

### Make the chat public

Replace `accessCookieAuth()` and `placeholderAuth()` with `none()` from `eve/channels/auth`, and remove the `beforeLoad` check from `apps/web/app/routes/__root.tsx`. Anyone with the URL can then chat with the agent and spend your AI Gateway credits, so keep the session limits in `agent/agent.ts`.

## Customize the chat interface

| Change | Location |
| --- | --- |
| Agent name in the header and on the home page | `DEFAULT_AGENT_NAME` in [agent-chat.tsx](apps/web/app/_components/agent-chat.tsx) |
| Keyboard shortcuts | `useChatHotkeys` in `apps/web/app/_components/agent-chat.tsx` |
| Home page footer | The `footer` element in [agent-chat.tsx](apps/web/app/_components/agent-chat.tsx) |
| Page title and description | `head` in [\_\_root.tsx](apps/web/app/routes/__root.tsx) |
| Messages, tool cards, questions, and approvals | [agent-message.tsx](apps/web/app/_components/agent-message.tsx) |
| Sign-in page | [login.tsx](apps/web/app/routes/login.tsx) |
| Colors for light and dark mode, including the `--success`, `--info`, and `--warning` status colors on cards | [globals.css](apps/web/app/globals.css) |

## Change how the app deploys

[vercel.ts](vercel.ts) configures the project's [Vercel Services](https://vercel.com/docs/services). It declares the `web` service, which builds the TanStack Start app in `apps/web`, and a route that sends every request to it. `withEve` from `eve/vercel` adds the agent as a second service, with a route that sends `/eve/v1/*` requests to the agent before they reach the web app.

To add a service of your own, such as an API, add it to `services` and put its route before the route that sends every request to `web`.

## Control sandbox network access

When deployed, [agent/sandbox.ts](agent/sandbox.ts) opens a Vercel Sandbox with all outbound network access denied, so commands the agent runs can't send data anywhere. The `web_fetch` tool runs outside the sandbox and `web_search` runs through the model provider, so both keep working. Local sessions use `just-bash`, which runs in process without network isolation.

To let deployed commands reach specific hosts, replace `"deny-all"` with a list of allowed hosts:

```ts
environment.open({ networkPolicy: { allow: { "api.github.com": [] } } });
```

See [eve's Vercel Sandbox documentation](https://eve.dev/docs/sandbox/vercel) for the other options.

## Remove features

| Feature | Files to remove or change |
| --- | --- |
| Approval demo | Remove `agent/tools/approval_demo.ts` |
| Questions | Remove `agent/tools/ask_question.ts` |
| Web search and fetching | Add `agent/tools/web_search.ts` and `agent/tools/web_fetch.ts`, each exporting `disableTool()` |
| Sandbox tools | Add `agent/tools/bash.ts`, `agent/tools/read_file.ts`, and `agent/tools/write_file.ts`, each exporting `disableTool()` |
| Password | Follow [Use your own sign-in](#use-your-own-sign-in) or [Make the chat public](#make-the-chat-public) |

## Test and deploy your changes

Run these checks before deploying:

```sh
pnpm validate
pnpm build
```

`pnpm validate` checks formatting, lint rules, and types, and looks for unused files, exports, and dependencies with `pnpm knip`. `pnpm fix` applies formatting and lint fixes, and `pnpm build` builds the agent and the web app.

To try a change, run `pnpm dev:app` and open the URL it prints. Deploy changes to production with `vercel deploy --prod`.
