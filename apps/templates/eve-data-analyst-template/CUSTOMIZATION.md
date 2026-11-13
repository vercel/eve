# Customize your data analyst

You can change the template's database access, metric definitions, and Slack behavior with environment variables and files in `agent/`.

Choose the task you want to complete:

- [Change environment variables](#change-environment-variables)
- [Use your own database](#use-your-own-database)
- [Write your metric definitions](#write-your-metric-definitions)
- [Control who can query what](#control-who-can-query-what)
- [Tune approvals and limits](#tune-approvals-and-limits)
- [Set the reporting time zone](#set-the-reporting-time-zone)
- [Change answer style and model settings](#change-answer-style-and-model-settings)
- [Customize what the agent remembers](#customize-what-the-agent-remembers)
- [Control Slack replies](#control-slack-replies)
- [Connect Stripe or PostHog](#connect-stripe-or-posthog)
- [Control Slack profile lookups](#control-slack-profile-lookups)
- [Remove features](#remove-features)
- [Test and deploy your changes](#test-and-deploy-your-changes)
- [Set up an existing project](#set-up-an-existing-project)

## Change environment variables

You can customize the agent's behavior and features with environment variables. For local development, add them to `.env.local` in the project folder. For the deployed agent, add each one to your Vercel project with `vercel env add` followed by its name:

```sh
vercel env add ANALYST_SCHEMAS
```

Enter the value when prompted, and choose the Vercel environments that should use it. To replace an existing value, add `--force`. Redeploy to production with `vercel deploy --prod` to apply the change.

| Environment variable | Default | What it controls |
| --- | --- | --- |
| `DATABASE_URL` | Required | Connection string for a database user that can create schemas and roles. Each deploy uses it to set up the database. |
| `ANALYST_SEED_DEMO_DATA` | `false` | `true` or `1` loads the demo data and reloads it when it's more than a week old. The deploy button sets it to `true`. |
| `ANALYST_SCHEMAS` | `analytics` | Comma-separated database schemas the agent explores |
| `ANALYST_SHARED_SCHEMAS` | Same as `ANALYST_SCHEMAS` | Schemas from `ANALYST_SCHEMAS` whose tables every role can read. Only roles you grant can read the others. |
| `ANALYST_TIMEZONE` | `UTC` | Time zone for periods such as "last month", and for timestamps |
| `ANALYST_DEFAULT_ROLE` | `analyst_readonly` | Database role for everyone the role map leaves out. An empty value limits access to the people and channels in the map. |
| `ANALYST_ROLE_MAP` | `{}` | JSON object that gives Slack users and channels their own database roles |
| `ANALYST_APPROVAL_COST` | `1000000` | Estimated query cost above which a query needs approval |
| `ANALYST_STATEMENT_TIMEOUT_MS` | `20000` | Time limit for each query in milliseconds, from 1,000 to 300,000 |
| `ANALYST_MAX_ROWS` | `500` | Rows the agent reads from each query result, from 10 to 5,000 |
| `ANALYST_DATABASE_URL` | Unset | Connection string for a read-only user you manage yourself, as described in [Give the agent a read-only connection](#give-the-agent-a-read-only-connection) |
| `ANALYST_LOGIN_PASSWORD` | Generated | Password for a read-only user created with `pnpm db:setup-sql` |
| `SLACK_CONNECTOR` | Set by Vercel Connect | Slack connector the agent posts with |
| `SLACK_AUTO_REPLY_CHANNEL_IDS` | Unset | Slack channels where the agent answers every new post |
| `SLACK_IDENTITY_EXCLUDED_USER_IDS` | Unset | Slack users to leave out of profile lookups |

An empty value counts as unset and uses the default, with one exception: an empty `ANALYST_DEFAULT_ROLE` turns on allowlist mode. The agent checks all of its settings the first time it queries and lists every problem in one message. `pnpm db:doctor` runs the same checks, and checks the database, from your machine.

## Use your own database

The agent works with any Postgres database, version 14 or later. If you have a read replica, point the agent at it so its queries stay separate from your production traffic.

### Let each deploy set up the database

This is how the Vercel deploy button in the README works, and it suits your own tables too:

1. Set `DATABASE_URL` to the connection string for a database user that can create schemas and roles, such as the database owner.
2. Set `ANALYST_SCHEMAS` to the schemas that hold your tables, such as `public,billing`. Every role can read them unless you also set `ANALYST_SHARED_SCHEMAS`, as described in [Keep a schema to certain teams](#keep-a-schema-to-certain-teams). Set `ANALYST_SEED_DEMO_DATA` to `false` if you don't want the demo data.
3. Redeploy.

During each deployment, a setup step runs before the agent is built.

The setup step:

- gives a base role read access to every table in `ANALYST_SHARED_SCHEMAS`, including tables added since the last deploy
- creates any extra roles named in `ANALYST_ROLE_MAP`
- creates a database user named `eve_analyst` that can only switch into those roles

The agent always queries as `eve_analyst`. Its password is calculated from the owner's password in `DATABASE_URL`, so you only manage one connection string. The agent reads `DATABASE_URL` only for that calculation. Include the password in `DATABASE_URL`. Without it, setup is skipped and the agent reports that it needs one. The password stays the same when you change the host, port, database name, or options such as `sslmode`.

Keep these in mind:

- Each deploy restores read access to every table in the shared schemas, even one you revoked. Put team-only tables in a schema that `ANALYST_SHARED_SCHEMAS` leaves out.
- Postgres has one `eve_analyst` user per server. Environments on the same server, such as preview and production, need a `DATABASE_URL` with the same password. Otherwise each deploy locks the others out.
- When you change the owner's password, redeploy so `eve_analyst` gets its new password.
- `eve_analyst` copies any `.suffix` from your user name, such as `eve_analyst.abcdefgh` for `postgres.abcdefgh`, which some connection poolers need. If your real user name contains a dot, such as `jane.doe`, the deploy log says so. In that case, follow [Give the agent a read-only connection](#give-the-agent-a-read-only-connection). Set `ANALYST_LOGIN_PASSWORD` to a new password when you run `pnpm db:setup-sql --apply`.

Setup never fails a deploy. Its log lines start with `[data analyst setup]`:

- Schema names that aren't valid, and shared schemas missing from `ANALYST_SCHEMAS`, are skipped and listed.
- When the demo data can't be reloaded, setup keeps the old data and still creates the roles.
- Until a later deploy's setup succeeds, the agent asks people in Slack to have an admin check it.

To run the same setup from your machine, add the environment variables to `.env.local` and run `pnpm db:setup`. Then run `pnpm db:doctor` to check the result.

### Give the agent a read-only connection

For production data, you can give the deployed agent a read-only connection string:

1. Add `DATABASE_URL` to `.env.local` and run `pnpm db:setup-sql --apply`. It creates the same roles and the `eve_analyst` user with a random password, then prints that user's connection string.
2. Save the printed connection string as `ANALYST_DATABASE_URL` in your Vercel project with `vercel env add ANALYST_DATABASE_URL`. With it set, deploys skip the setup step and the agent connects with it directly.
3. Remove `DATABASE_URL` from production with `vercel env rm DATABASE_URL production`, then redeploy.

You can run `pnpm db:setup-sql --apply` again at any time, and `eve_analyst` keeps its password unless you set `ANALYST_LOGIN_PASSWORD`. The printed connection string keeps a connection pooler's `.suffix` on the user name. With `--apply`, the script checks with Postgres whether the dot is part of your real user name, and leaves the suffix off in that case. Add `--login <name>` to choose a different user name.

To have a database administrator review and run the SQL, save it to a file with `pnpm --silent db:setup-sql > setup.sql`.

### Describe your columns

The agent reads table and column comments when it explores your database, so a comment such as `COMMENT ON COLUMN billing.invoices.amount IS 'USD cents, tax excluded'` leads to correct answers about invoice totals. Comment the columns that carry units, exclusions, or surprises, such as a status column that reflects only the current state.

### Reach a private database

For a database on a private network, use [Vercel Secure Compute](https://vercel.com/docs/secure-compute) to give the deployed agent a private connection to it.

### Remove the demo data

Set `ANALYST_SEED_DEMO_DATA` to `false`, remove `analytics` from `ANALYST_SCHEMAS`, and run `DROP SCHEMA analytics CASCADE;` as the database owner. To load demo data into a different schema, run `pnpm db:seed --schema <name>`. The seed script replaces only schemas it created itself, and `--force` lets it replace one it didn't. When someone adds a table to the schema, or creates a view on its tables, while new data loads, the seed and the deploy keep the old data and say why. Run `pnpm db:seed --force` to replace the schema anyway, which also drops those objects. The seed builds new data in a schema named `eve_demo_staging` and swaps it in when loading finishes, so leave that name free.

## Write your metric definitions

[agent/skills/metric-definitions.md](agent/skills/metric-definitions.md) is the most important file to customize. The agent loads it before calculating any business metric, and it takes priority over anything in memory. The template's definitions describe the demo data, so replace them with your own tables and rules.

Give each metric a name, a one-line definition, the SQL that calculates it, and its time and filter rules. Write down the choices people disagree about, such as whether MRR includes discounts, which accounts count as internal, and whether a week starts on Monday. When a question uses a metric the file leaves out, the agent says which definition it assumed.

[agent/skills/sql-style.md](agent/skills/sql-style.md) holds SQL conventions, such as filling gaps in time series and dividing safely. Add any patterns your database needs, such as joining a calendar table.

The evals in `evals/` calculate their expected answers with the SQL in [scripts/seed/sql.ts](scripts/seed/sql.ts). When you change the MRR or traffic definitions, update that file and the evals to match, or delete the evals written for the demo data.

## Control who can query what

Each person queries as a Postgres role, so your database permissions decide what they can see. The agent's `eve_analyst` user has no permissions of its own. For every query, it switches into the role of the person asking, and switches back when the query finishes.

### Give a person or a channel its own role

The `ANALYST_ROLE_MAP` environment variable is a JSON object that maps Slack users and channels to database roles. For a person, use their Slack member ID, which you can copy from their profile through the ⋮ menu and **Copy member ID**. For a channel, use its channel ID, shown at the bottom of the channel's **About** details.

```dotenv
ANALYST_ROLE_MAP={"U0456EFGH":"analyst_exec","C0789IJKL":"analyst_finance"}
```

A person's role applies in every channel and direct message. A channel's role applies to everyone who asks in that channel, which suits team channels such as a finance or leadership channel. Everyone in a channel sees the answers posted there, so give a channel a role whose data all of its members may see. When a person with their own role asks in a mapped channel, the channel's role applies.

Channel roles apply to people. A bot or Slack Workflow posting in a mapped channel uses its own entry in the map.

If one deployment serves several Slack workspaces, you can use full IDs such as `slack:T0123ABCD:U0456EFGH`, which include the workspace. When a person's member ID and full ID both name a role, the full ID wins.

When someone with a different role joins a thread that already has answers, the agent asks them to start a new thread. Answers fetched with one role stay with the people who have it. People who share a role, such as everyone in a channel mapped to one role, keep talking in the same thread.

After adding a role, redeploy or run `pnpm db:setup` to create it. Every role starts with the base role's access, which covers the schemas in `ANALYST_SHARED_SCHEMAS`. To give a role more, see [Keep a schema to certain teams](#keep-a-schema-to-certain-teams). To limit which rows a role sees, add [row-level security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) policies that check `current_user`. Roles a policy leaves out get no rows, so the agent reports an empty result for them.

### Keep a schema to certain teams

List the schema in `ANALYST_SCHEMAS` so the agent explores it, and leave it out of `ANALYST_SHARED_SCHEMAS` so the base role gets nothing in it. For example, to keep a `billing` schema to the finance team:

```dotenv
ANALYST_SCHEMAS=public,billing
ANALYST_SHARED_SCHEMAS=public
ANALYST_ROLE_MAP={"C0789IJKL":"analyst_finance"}
```

Every schema in `ANALYST_SHARED_SCHEMAS` must also be in `ANALYST_SCHEMAS`, and the agent and `pnpm db:doctor` report one that isn't. Redeploy or run `pnpm db:setup`, then grant the team's role access as the database owner:

```sql
GRANT USAGE ON SCHEMA billing TO analyst_finance;
GRANT SELECT ON ALL TABLES IN SCHEMA billing TO analyst_finance;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT SELECT ON TABLES TO analyst_finance;
```

Deploys leave these grants alone. The last statement covers tables that the database owner creates later. For tables created by another database user, such as a migration user, add `FOR ROLE <that user>` after `ALTER DEFAULT PRIVILEGES`, or run the second statement again after new tables appear.

When someone asks a question, the agent only finds the tables their role can read. People in the finance channel see the `billing` tables, and everyone else doesn't.

If the schema was in `ANALYST_SHARED_SCHEMAS` before, earlier deploys already gave the base role access to it. Deploys never take access away, so remove it as the database owner. The base role is the one named in `ANALYST_DEFAULT_ROLE`, or `analyst_readonly` when that's unset or empty. This example uses `analyst_readonly`:

```sql
REVOKE SELECT ON ALL TABLES IN SCHEMA billing FROM analyst_readonly;
REVOKE USAGE ON SCHEMA billing FROM analyst_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing REVOKE SELECT ON TABLES FROM analyst_readonly;
```

`pnpm db:doctor` warns when the base role still has any of these grants in a schema that `ANALYST_SHARED_SCHEMAS` leaves out, and prints the statements to run.

### Turn access off or limit it to a list

To turn off a person's access everywhere, map them to an empty role, `""`, under either their member ID or their full ID. The empty entry wins over a role under the other ID and over a channel's role. Mapping a channel to `""` turns off questions in that channel. To allow only the people and channels in the map, set `ANALYST_DEFAULT_ROLE` to an empty value.

### Bots, workflows, and API callers

Bots, Slack Workflows, and programs calling the agent's HTTP API get access when their ID is in `ANALYST_ROLE_MAP`. Slack bots have IDs such as `slack:T0123ABCD:bot:B0123ABCD`. Programs calling the HTTP API also use their full ID. Short Slack-style IDs, such as `U0456EFGH` or `C0789IJKL`, only match Slack people and channels. Approvals for expensive queries always come from a person.

### Separate teams completely

The agent refuses queries that use `set_config()` or functions that run SQL text, such as `query_to_xml()` and `ts_stat()`, because those could switch into another team's role. That list can't cover every function that runs SQL, such as one your team writes in PL/pgSQL. For teams whose data must stay fully separate, give each team its own deployment and database user, with access to that team's role only. On a self-managed Postgres server you can also run the `REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(...)` statement included as a comment at the end of the setup SQL. That statement applies to every role in the database.

On Postgres 14 and older, every database user can create functions in the `public` schema by default. When `public` is in `ANALYST_SCHEMAS`, someone could add a function there that the agent can't tell apart from a built-in one. Run `REVOKE CREATE ON SCHEMA public FROM PUBLIC;` as the database owner to turn that off. Postgres 15 and newer already leave it off.

## Tune approvals and limits

Before running a query, the agent asks Postgres how much work the query will take, using `EXPLAIN`, which estimates the cost without running the query. When the estimate is above `ANALYST_APPROVAL_COST`, Slack shows an approval card with the query's purpose, the estimate, and the SQL. The person who asked can then run or cancel the query. Bots are asked to narrow the query instead.

Cost estimates depend on your data and hardware, so the default only catches very expensive queries, such as large joins. `pnpm db:doctor` shows the estimated cost of reading your largest table and suggests a value that also covers queries over a whole table. Lower the value for more approvals, or raise it for fewer.

`ANALYST_STATEMENT_TIMEOUT_MS` stops any query that runs longer than the limit. `ANALYST_MAX_ROWS` caps the rows the agent reads from a result, and when a result is cut short, the agent summarizes the data in SQL instead.

## Set the reporting time zone

`ANALYST_TIMEZONE` sets the time zone for every query, so dates and times in SQL and in answers all use it. The agent also knows the local date, so "last month" and "yesterday" match your team's calendar. Use a time zone name such as `America/New_York` or `Europe/London`.

## Change answer style and model settings

[agent/instructions.md](agent/instructions.md) sets the agent's persona, answer format, chart choices, and writing style.

[agent/agent.ts](agent/agent.ts) sets the model and session limits. The template uses Claude Opus 5.5 with medium reasoning, which writes reliable SQL. Use `reasoning: "high"` for complex analysis such as cohorts and retention, or a faster model for quick lookups. To cap spending per conversation, add `maxTokenCostUsdPerSession` to `limits`. When a conversation reaches a limit, eve asks whether to continue.

## Customize what the agent remembers

The agent keeps two kinds of memory. User memory holds one person's preferences, and channel memory holds conventions for everyone in a Slack channel. Each memory's `description` in [agent/memory/](agent/memory/) says what it holds, and the Memory section of [agent/instructions.md](agent/instructions.md) says when to use each one. Metric definitions stay in the skill file.

On Vercel, memory is stored in the private Blob store the deploy button created. During `pnpm dev`, memory lasts until the server restarts.

## Control Slack replies

The agent replies when someone mentions it or sends it a direct message. In a thread it's already part of, it also answers follow-up messages from the person who started the conversation, as long as nobody else has joined. To have it answer every new post in certain channels, such as an `#ask-data` channel, list their channel IDs:

```dotenv
SLACK_AUTO_REPLY_CHANNEL_IDS=C0123ABCD,C0456EFGH
```

When the agent posts a chart or table, the headline answer appears as the chart's summary.

### The SQL query section

Answers that ran SQL end with a collapsed section titled "SQL query", or "SQL queries (2)" when there are several. It lists up to three queries with the tables each one read, and a "Data as of" time that Slack shows in each reader's time zone. The section lists the queries that ran successfully, exactly as they ran. If Slack rejects the section, the same SQL appears in the reply as a code block instead. For a chart or table, the agent first posts it again with the SQL shown open below it. When Slack rejects that too, or the message is too large, the agent posts the chart or table on its own and the SQL as a separate message. Plain text with the SQL is the last resort.

To change the section's title or layout, edit `agent/lib/analyst/sql-attachment.ts`. The number of queries is set by `MAX_ATTACHED_QUERIES` in `agent/lib/analyst/query-log.ts`, and Slack's limit of 10 blocks per section keeps it at three or fewer. To show SQL inside the answer text instead, remove the section from `agent/lib/integrations/slack/replies.ts` and `agent/lib/integrations/slack/visualizations/post.ts`, and update the Answer format section of `agent/instructions.md`.

## Connect Stripe or PostHog

Your database stays the reference for the metrics you define. Connections let the agent look up details it holds elsewhere, such as a customer's current Stripe subscription or a PostHog insight. Install a connection from the eve registry:

```sh
pnpm exec eve add connection/stripe --non-interactive
pnpm exec eve add connection/posthog --non-interactive
```

Each command writes a file under `agent/connections/`. When it needs another step first, such as linking the project, it exits with code 2 and prints the command to run next. The agent's instructions already tell it to prefer your database, name the source of each number, and keep numbers from different sources separate.

By default, each person signs in to the connected service with their own account. The first time the agent uses the connection for someone in Slack, it sends them a private sign-in link. Sessions in `pnpm dev`, and requests from bots, need a shared account instead. To use one shared account for everyone, change `connect("stripe")` to `connect({ connector: "stripe", principalType: "app" })`.

Connections send requests directly to the service, and some services offer tools that change data, such as creating refunds in Stripe. List only the tools that read data in `tools.allow`:

```ts
import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  auth: connect({ connector: "stripe", principalType: "app" }),
  description:
    "Stripe account: look up customers, subscriptions, and invoices.",
  tools: { allow: ["list_customers", "list_subscriptions", "list_invoices"] },
  url: "https://mcp.stripe.com",
});
```

The tool names above are examples. Check the current names in the service's documentation, or ask the agent in `pnpm dev` to list the connection's tools. To allow a tool that changes data only with a person's sign-off, add `approval: once()` from `eve/tools/approval` to the connection.

## Control Slack profile lookups

Before replying, the agent looks up the Slack profiles of the people in the thread, including anyone mentioned, and adds their names to the conversation. Email addresses stay out, and database access always comes from the verified Slack user ID.

To leave certain accounts out of profile lookups, such as bots, list their Slack user IDs:

```dotenv
SLACK_IDENTITY_EXCLUDED_USER_IDS=U0123456789,U0987654321
```

## Remove features

| Feature | Files to remove or change |
| --- | --- |
| Slack | Remove `agent/channels/slack.ts`, `agent/tools/post_slack_chart.ts`, `agent/tools/post_slack_table.ts`, and `agent/hooks/reply-continuation.ts` |
| Channel memory | Remove `agent/memory/channel-preferences.ts` |
| All memory | Remove `agent/memory/` and the Memory section of `agent/instructions.md` |
| Demo data | Remove `scripts/seed.ts`, `scripts/seed/generate.ts`, `scripts/seed/schema.ts`, and the `db:seed` script. The evals use `scripts/seed/sql.ts`, so remove `evals/` too, or rewrite the evals for your data. |
| Sandbox commands | Add `agent/tools/bash.ts` and `agent/tools/write_file.ts`, each exporting `disableTool()` |

## Test and deploy your changes

Run these checks before deploying:

```sh
pnpm validate
pnpm exec eve info
pnpm build
```

`pnpm validate` checks formatting, lint rules, and types, runs the unit tests, and looks for unused code. The unit tests cover the safety checks, role resolution, approvals, and the demo data generator, and they run without a database.

`pnpm eval` asks the agent real questions about the demo data and checks the answers. It covers exploring the schema, using the metric definitions, answering last month's MRR and the top traffic source, declining to change data, and pausing expensive queries for approval. Expected answers come from the current data, so they stay correct as the demo data changes. When `pnpm db:doctor` reports that the demo data is out of date, run `pnpm db:setup` or redeploy to refresh it.

Some evals are scored by a second model, set in [evals/evals.config.ts](evals/evals.config.ts) to `openai/gpt-6-luna-decisions` through AI Gateway. If your team limits which AI Gateway providers it uses, allow OpenAI in the gateway settings, or set `judge.model` to another decision model from eve's [judge documentation](https://eve.dev/docs/evals/judge).

Deploy with `vercel deploy --prod`, which keeps your local `.env.local` file as it is.

## Set up an existing project

To add the template to a Vercel project you created without the deploy button, connect each service yourself:

1. Connect Slack with `pnpm exec eve add channel/slack --non-interactive` and run the commands it prints. This sets `SLACK_CONNECTOR`.
2. Create a private Blob store for memory and connect it to the project:

   ```sh
   vercel blob create-store <name> --access private --yes
   ```

3. Add `DATABASE_URL` with `vercel env add DATABASE_URL`. Add `ANALYST_SEED_DEMO_DATA` with the value `true` to load the demo data.
4. Deploy with `vercel deploy --prod`. The deploy sets up the database before building the agent.
