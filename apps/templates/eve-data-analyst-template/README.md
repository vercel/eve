# eve Data Analyst Template

[![Agent Stack](https://img.shields.io/badge/Agent%20Stack-000?style=flat-square&logo=vercel&logoColor=FFF&labelColor=000&color=000)](https://vercel.com/kb/agent-stack) [![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

Slack-based data analyst built on [eve](https://eve.dev/) that answers questions about your business from a Postgres database. Ask "What was our MRR last month?" in Slack and it replies with the number, plus a chart or table when one helps.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-data-analyst-template&project-name=eve-data-analyst&repository-name=eve-data-analyst&env=DATABASE_URL%2CANALYST_SEED_DEMO_DATA&envDefaults=%7B%22ANALYST_SEED_DEMO_DATA%22%3A%22true%22%7D&envDescription=The%20Postgres%20connection%20string%20for%20a%20role%20that%20can%20create%20schemas%20and%20roles%2C%20and%20whether%20to%20load%20demo%20data.&envLink=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-data-analyst-template%23getting-started&connect=%5B%7B%22type%22%3A%22slack%22%2C%22env%22%3A%22SLACK_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fslack%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D)

## Getting started

Vercel's project setup flow will create a repository in your Git account and a Vercel project. You'll create and install a Slack app via Vercel Connect, and the flow adds a private Vercel Blob store for the agent's memory. You'll then be prompted to add the following environment variables:

| Environment variable | What to enter |
| --- | --- |
| `DATABASE_URL` | The connection string for your Postgres database, version 14 or later. Use a database user that can create schemas and roles, such as the database owner. |
| `ANALYST_SEED_DEMO_DATA` | `true` loads demo data for a fictional SaaS company, with 18 months of subscriptions, billing, and website traffic. Enter `false` to use your own data. |

Each deploy prepares your database before building the agent. It loads the demo data when `ANALYST_SEED_DEMO_DATA` is `true`, and it creates the read-only database user the agent queries with.

When the deploy finishes, add the agent to a Slack channel, @mention it, and ask "What was our MRR last month?"

### Use your own data

Add an environment variable named `ANALYST_SCHEMAS` that lists the database schemas holding your tables, separated by commas, such as `public,billing`. Then redeploy. [Use your own database](CUSTOMIZATION.md#use-your-own-database) in the customization guide covers the other available options.

## Tech stack

| Layer             | Technology     |
| ----------------- | -------------- |
| Agent framework   | eve            |
| Slack integration | Vercel Connect |
| Data              | Postgres       |
| Memory storage    | Vercel Blob    |
| Sandbox           | Vercel Sandbox |

## How it answers

The agent looks up which tables it can read and what their columns mean, then loads your metric definitions from [agent/skills/metric-definitions.md](agent/skills/metric-definitions.md), so terms like "MRR" and "churn" follow your team's rules. It runs a summarizing query and replies with the number, the exact period, and the time zone. Trends, rankings, and breakdowns appear as Slack charts and tables.

Below each answer, a collapsed "SQL query" section shows the queries the agent ran, the tables each one read, and when it ran. The agent remembers preferences such as number formatting or a channel's default region, while metric definitions stay in the skill file.

## How it stays safe

The agent can only read your database. These safeguards keep it that way and protect your data:

- The agent connects as a dedicated database user, which reads data through the asking person's role.
- Every query runs in a read-only transaction with a time limit, and the transaction is rolled back afterwards.
- Each query is wrapped so the database runs it as a single `SELECT` statement.
- Before running a query, the agent asks Postgres to estimate its cost. Expensive queries wait for approval from the person who asked.
- Query results stay in the conversation, because web search, web fetching, and outbound network access are turned off.
- Query results, column descriptions, Slack messages, and memory are treated as information to read rather than instructions to follow.

## Access control

Each person queries as a Postgres role, so your database permissions decide what they can see. Everyone uses the role named in the `ANALYST_DEFAULT_ROLE` environment variable, which is `analyst_readonly` by default. To give a specific person or everyone in a Slack channel their own role, set the `ANALYST_ROLE_MAP` environment variable to a JSON object of Slack IDs and role names:

```dotenv
ANALYST_ROLE_MAP={"U0456EFGH":"analyst_exec","C0789IJKL":"analyst_finance","U0999ZZZZ":""}
```

In this example, the person `U0456EFGH` queries as `analyst_exec` wherever they ask, everyone in the channel `C0789IJKL` queries as `analyst_finance` there, and an empty role turns off access for `U0999ZZZZ`. Bots, including Slack Workflows, get access once you add them to the map. See [Control who can query what](CUSTOMIZATION.md#control-who-can-query-what) for how roles combine and how to set up team roles.

## Local development

Use Node.js 24 and pnpm, and install the [Vercel CLI](https://vercel.com/docs/cli). Then clone your repository.

1. Link the project and pull its development environment variables into `.env.local`:

   ```sh
   pnpm install
   vercel link
   vercel env pull .env.local
   ```

   Choose your deployed project when prompted. This also saves a Vercel OIDC token that lets the agent use AI Gateway locally. It expires after about 12 hours, so rerun `vercel env pull .env.local` to get a new one.

2. Add your database connection string and demo data setting to `.env.local`, since `vercel env pull` copies non-sensitive values only:

   ```dotenv
   DATABASE_URL=postgres://user:password@host:5432/database
   ANALYST_SEED_DEMO_DATA=true
   ```

   Use the same `DATABASE_URL` as your Vercel project, or a local Postgres database such as one started with `docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17`.

3. Prepare the database the same way a deploy does, and start the agent:

   ```sh
   pnpm db:setup
   pnpm dev
   ```

`pnpm dev` opens eve's interactive chat in your terminal. Ask "What was our MRR last month?" to try the full path from schema lookup to answer. Local sessions answer in plain text, because Slack charts and tables appear in Slack threads. Run `pnpm db:doctor` to check that the database is set up the way the agent expects.

Before deploying, check your changes and confirm the agent builds:

```sh
pnpm validate
pnpm exec eve info
pnpm build
```

`pnpm eval` runs automated checks that ask the agent real questions about the demo data, such as last month's MRR. `pnpm fix` applies formatting and lint fixes. Deploy with `vercel deploy --prod`, which keeps your `.env.local` file as it is.

## Customization

| Customize | Where |
| --- | --- |
| Metric definitions | [agent/skills/metric-definitions.md](agent/skills/metric-definitions.md) |
| SQL conventions | [agent/skills/sql-style.md](agent/skills/sql-style.md) |
| Answer format, persona, and response style | [agent/instructions.md](agent/instructions.md) |
| Schemas, time zone, roles, and limits | Environment variables listed in [.env.example](.env.example) |
| What memory saves | `description` in [agent/memory/](agent/memory/) |
| Model and session limits | [agent/agent.ts](agent/agent.ts) |

For more, including team roles, approval thresholds, and connecting Stripe or PostHog, see [CUSTOMIZATION.md](CUSTOMIZATION.md).
