# eve Agent with Python Template

[![Agent Stack](https://img.shields.io/badge/Agent%20Stack-000?style=flat-square&logo=vercel&logoColor=FFF&labelColor=000&color=000)](https://vercel.com/kb/agent-stack) [![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

Web chat built on [eve](https://eve.dev/docs/guides/frontend/nextjs), [Next.js](https://nextjs.org), and a Python [FastAPI](https://fastapi.tiangolo.com) backend, where the agent manages a shared task list and runs Python tools. Ask "Add a task to renew the domain" and the agent creates it through the FastAPI backend, then it appears on the app's Tasks page.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-agent-python-template&project-name=eve-agent-python&repository-name=eve-agent-python&env=EVE_CHAT_PASSWORD&envDescription=The%20password%20visitors%20enter%20before%20they%20can%20use%20the%20app%20and%20chat%20with%20the%20agent.&envLink=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-agent-python-template%23getting-started&products=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22neon%22%2C%22integrationSlug%22%3A%22neon%22%7D%5D)

## Getting started

Vercel's project setup flow will create a repository in your Git account and a Vercel project. You'll then be prompted to add the following environment variable and database:

| Setting | What to enter |
| --- | --- |
| `EVE_CHAT_PASSWORD` | The password visitors enter before they can use the app. Share it with the people who should have access. |
| Neon | Configure the Neon integration to create a Postgres database. It sets the `DATABASE_URL` environment variable, which the backend uses to store tasks. |

When the deploy finishes, open the deployment URL and enter the password. Then ask the agent to add a task, such as "Add a task to renew the domain", and open Tasks to see it.

## Tech stack

| Layer              | Technology                 |
| ------------------ | -------------------------- |
| Agent framework    | eve                        |
| Generative UI      | json-render                |
| Sandbox            | Vercel Sandbox             |
| Deployment         | Vercel Services            |
| Frontend framework | Next.js                    |
| Backend framework  | FastAPI                    |
| Database           | Neon Postgres and SQLModel |
| Python packages    | uv                         |
| Data tables        | TanStack Table             |

## How the chat works

The agent lives in [agent/](agent/), the chat and the other pages live in [apps/web/](apps/web/), and the FastAPI backend lives in [apps/api/](apps/api/). They deploy together with [Vercel Services](https://vercel.com/docs/services) in one project. [vercel.ts](vercel.ts) adds the agent with `withEve` and gives the agent and the web app the backend's URL in the `BACKEND_URL` environment variable. The backend has no public route, so browsers reach it only through the web app.

Ask the agent to add, complete, or delete tasks and it calls the same FastAPI endpoints that the Tasks page uses. Changes made in the chat or on the page show up in both. For statistics or text analysis it runs Python code in the backend instead of doing the math itself. You can reload the page to return to the conversation later, or share its link with anyone who has the password.

| Tool | File | What the chat shows |
| --- | --- | --- |
| `list_tasks`, `create_task`, and `update_task` | [agent/tools/](agent/tools/) | Task cards from the shared task list |
| `delete_task` | [delete_task.ts](agent/tools/delete_task.ts) | Asks for your approval before it deletes the task |
| `compute_stats` | [compute_stats.ts](agent/tools/compute_stats.ts) | Mean, median, quartiles, and other statistics, computed in Python |
| `analyze_text` | [analyze_text.ts](agent/tools/analyze_text.ts) | Word counts, reading time, readability, and the most common words, computed in Python |
| `render_ui` | [render_ui.ts](agent/tools/render_ui.ts) | Result cards, metrics, tables, and other components from a fixed catalog |
| `ask_question` | [ask_question.ts](agent/tools/ask_question.ts) | Options to choose from, or a field to type an answer |

The Backend page shows which Python and FastAPI versions the backend runs and has a form that computes statistics with the same Python endpoint as `compute_stats`. The API page lists every endpoint the backend describes in its OpenAPI document.

## Access control

Visitors who haven't signed in are sent to a sign-in page to enter the password set in the `EVE_CHAT_PASSWORD` environment variable. Choose a long random password, such as the output of `openssl rand -base64 32`. Everyone with the password is trusted equally and shares one task list, so share it only with people who may see each other's chats and tasks.

Until you set `EVE_CHAT_PASSWORD`, the sign-in page asks you to set it. To replace the password with Clerk, Better Auth, or another auth provider, see [Change who can use the app](CUSTOMIZATION.md#change-who-can-use-the-app) in the customization guide.

## Local development

Use Node.js 24, pnpm, and [uv](https://docs.astral.sh/uv/), which installs the backend's Python packages. Install the [Vercel CLI](https://vercel.com/docs/cli), then clone your repository and run:

```sh
pnpm install
vercel link
vercel env pull .env.local
pnpm dev:all
```

Choose your deployed project when `vercel link` prompts you. `vercel env pull .env.local` saves your project's development environment variables to `.env.local`, including the token that lets the agent call models through [Vercel AI Gateway](https://vercel.com/docs/ai-gateway).

`pnpm dev:all` starts the web app, agent, and backend together with `vercel dev`, and routes requests to them the same way a deployment does. Open the URL it prints and send a message. When `EVE_CHAT_PASSWORD` is unset, the app opens without a password. When `DATABASE_URL` is unset, the backend stores tasks in a SQLite file at `apps/api/.data/dev.sqlite3`. 

To chat with the agent in your terminal instead, run `pnpm dev:api` and `pnpm dev:eve` in two terminals.

Before deploying, check your changes and confirm the agent and the web app build:

```sh
pnpm typecheck
pnpm test
pnpm lint:api
pnpm build
```

`pnpm test` runs the backend's tests with pytest, and `pnpm lint:api` checks its Python code with Ruff. When the checks pass, deploy with:

```sh
vercel deploy --prod
```

## Customization

| Customize | Where |
| --- | --- |
| Persona and response style | [agent/instructions.md](agent/instructions.md) |
| Tools | [agent/tools/](agent/tools/) |
| Backend endpoints and Python tools | [apps/api/routers/](apps/api/routers/) |
| Cards for task and Python tool results | [apps/web/app/\_components/tool-cards.tsx](apps/web/app/_components/tool-cards.tsx) |
| Components the agent can render | [agent/lib/ui-catalog.ts](agent/lib/ui-catalog.ts) and [apps/web/app/\_components/ui-registry.tsx](apps/web/app/_components/ui-registry.tsx) |
| Chat interface | [apps/web/app/\_components/](apps/web/app/_components/) |

For more ways to customize the template, including adding backend endpoints and Python tools, using your own authentication provider, and connecting another eve agent such as the [eve Data Analyst Template](https://github.com/vercel-labs/eve-data-analyst-template), see the [customization guide](CUSTOMIZATION.md).

## Resources

- [eve documentation](https://eve.dev/docs)
- [eve Next.js guide](https://eve.dev/docs/guides/frontend/nextjs)
- [Next.js documentation](https://nextjs.org/docs)
- [FastAPI documentation](https://fastapi.tiangolo.com)
- [Vercel Services](https://vercel.com/docs/services)
- [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox)
- [eve Data Analyst Template](https://github.com/vercel-labs/eve-data-analyst-template)
