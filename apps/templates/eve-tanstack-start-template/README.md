# eve TanStack Start Template

[![Agent Stack](https://img.shields.io/badge/Agent%20Stack-000?style=flat-square&logo=vercel&logoColor=FFF&labelColor=000&color=000)](https://vercel.com/kb/agent-stack) [![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

Web chat built on [eve](https://eve.dev/docs/guides/frontend/tanstack) and [TanStack Start](https://tanstack.com/start), where the agent can respond with generative UI like tables and dashboards. Ask "Find me the latest Vercel blog posts" and the agent searches the web, then returns a row of result cards with a preview image and summary for each post.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-tanstack-start-template&project-name=eve-tanstack-start&repository-name=eve-tanstack-start&env=EVE_ACCESS_PASSWORD&envDescription=The%20password%20visitors%20enter%20before%20they%20can%20chat%20with%20the%20agent.&envLink=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-tanstack-start-template%23getting-started)

## Getting started

Vercel's project setup flow will create a repository in your Git account and a Vercel project. You'll then be prompted to add the following environment variable:

| Environment variable | What to enter |
| --- | --- |
| `EVE_ACCESS_PASSWORD` | The password visitors enter before they can chat. Share it with the people who should have access. |

When the deploy finishes, open the deployment URL and enter the password. Then ask the agent something that needs a web search, such as "Find me the latest Vercel blog posts".

## Tech stack

| Layer              | Technology       |
| ------------------ | ---------------- |
| Agent framework    | eve              |
| Generative UI      | json-render      |
| Sandbox            | Vercel Sandbox   |
| Deployment         | Vercel Services  |
| Frontend framework | TanStack Start   |
| Data tables        | TanStack Table   |
| Keyboard shortcuts | TanStack Hotkeys |

## How the chat works

The agent lives in [agent/](agent/), and the chat lives in [apps/web/](apps/web/). They deploy together with [Vercel Services](https://vercel.com/docs/services) in one project, and [vercel.ts](vercel.ts) wraps the chat's service in `withEve`.

Ask the agent to find the latest Vercel blog posts and it searches the web before showing them as cards. When it needs your input it asks with a short form. You can reload the page to return to the conversation later, or share its link with anyone who has the password.

| Tool | File | What the chat shows |
| --- | --- | --- |
| `render_ui` | [render_ui.ts](agent/tools/render_ui.ts) | Result cards, metrics, tables, and other components from a fixed catalog |
| `ask_question` | [ask_question.ts](agent/tools/ask_question.ts) | Options to choose from, or a field to type an answer |
| `approval_demo` | [approval_demo.ts](agent/tools/approval_demo.ts) | Asks for your approval before it runs |

## Access control

Visitors who haven't signed in are sent to a sign-in page to enter the password set in the `EVE_ACCESS_PASSWORD` environment variable. Choose a long random password, such as the output of `openssl rand -base64 32`. Everyone with the password is trusted equally, so share it only with people who may see each other's chats.

Until you set `EVE_ACCESS_PASSWORD`, the sign-in page asks you to set it. To replace the password with Clerk, Better Auth, or another auth provider, see [Change who can use the chat](CUSTOMIZATION.md#change-who-can-use-the-chat) in the customization guide.

## Local development

Use Node.js 24 and pnpm. Install the [Vercel CLI](https://vercel.com/docs/cli), then clone your repository and run:

```sh
pnpm install
vercel link
vercel env pull .env.local
pnpm dev:app
```

Choose your deployed project when `vercel link` prompts you. `vercel env pull .env.local` saves your project's development environment variables to `.env.local`.

`pnpm dev:app` starts the chat and the agent together with `vercel dev`, and routes `/eve/v1/*` requests to the agent the same way a deployment does. Open the URL it prints and send a message. When `EVE_ACCESS_PASSWORD` is unset, the chat opens without a password. To chat with the agent in your terminal instead, run `pnpm dev:agent`.

Before deploying, check your changes and confirm the agent and the web app build:

```sh
pnpm validate
pnpm build
```

Use `pnpm fix` to apply automatic formatting and lint fixes. When the checks pass, deploy with:

```sh
vercel deploy --prod
```

## Customization

| Customize | Where |
| --- | --- |
| Persona and response style | [agent/instructions.md](agent/instructions.md) |
| Tools | [agent/tools/](agent/tools/) |
| Components the agent can render | [agent/lib/ui-catalog.ts](agent/lib/ui-catalog.ts) and [apps/web/app/\_components/ui-registry.tsx](apps/web/app/_components/ui-registry.tsx) |
| Chat interface | [apps/web/app/\_components/](apps/web/app/_components/) |

For more ways to customize the agent, including adding components, using your own authentication provider, and connecting another eve agent such as the [eve Data Analyst Template](https://github.com/vercel-labs/eve-data-analyst-template), see [CUSTOMIZATION.md](CUSTOMIZATION.md).

## Resources

- [eve documentation](https://eve.dev/docs)
- [eve TanStack Start guide](https://eve.dev/docs/guides/frontend/tanstack)
- [TanStack Start](https://tanstack.com/start)
- [Vercel Services](https://vercel.com/docs/services)
- [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox)
- [eve Data Analyst Template](https://github.com/vercel-labs/eve-data-analyst-template)
