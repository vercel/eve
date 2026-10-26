# Company Brain Template

Ask an eve agent about dbt models and their data from Slack. The example uses
Jaffle Shop customers, orders, and payments. dbt builds the tables and supplies
model documentation; the agent reads that documentation before querying.

Local DuckDB and MotherDuck use the same client, SQL, and three authored tools:
`list_models`, `get_model`, and `query_sql`. Change `DUCKDB_CONNECTION` from a file
path to `md:jaffle_shop` to select MotherDuck. MotherDuck also requires a token
and its own copy of the models; changing the connection does not upload your
local database.

This template is not a production access-control or metrics platform.
There is no separate semantic layer, vector database, or persistent business
memory. The project is standalone; copy this directory out of the eve repository
to use it.

## Run locally

Prerequisites: Node.js 24 or newer, pnpm 12, and [uv](https://docs.astral.sh/uv/).
The data command uses Python 3.13 through uv. No Docker daemon or warehouse
account is needed for the local database; the agent's default workspace uses
just-bash. Model calls require an AI Gateway credential or Vercel project OIDC.

```bash
pnpm install
cp .env.example .env.local
pnpm data:build
```

Set `AI_GATEWAY_API_KEY` in `.env.local`, or run `pnpm exec eve link` to link a
Vercel project and pull its local environment. To use the local terminal UI,
generate an HTTP operator password in `.env.local`:

```bash
node --input-type=module - <<'JS'
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
appendFileSync('.env.local', `\nCOMPANY_BRAIN_HTTP_PASSWORD=${randomBytes(32).toString('hex')}\n`);
JS
pnpm dev
```

`pnpm dev` starts the server without a terminal UI. In a second terminal in the
same directory, connect with the operator credentials:

```bash
AUTH=$(node --env-file=.env.local -e 'process.stdout.write(Buffer.from("company-brain:" + process.env.COMPANY_BRAIN_HTTP_PASSWORD).toString("base64"))')
pnpm exec eve remote connect --url http://127.0.0.1:2000 --header "Authorization: Basic $AUTH"
unset AUTH
```

The username is `company-brain`. Anyone with this password can query all exposed
models in development. Keep it private and do not deploy it. For Slack-only
development, skip generating the password; HTTP session routes remain disabled.

Try these questions in the authenticated terminal UI:

- “What is included in our payment totals?”
- “How many orders do we have, and what dates do they cover?”
- “Show recorded payment totals by month for the available sample period.”
- “How are customer lifetime totals calculated?”

The seeds contain 100 customers and 99 orders dated January 1–April 9, 2018.
The sum of recorded order payments is AUD 1,672. That amount includes all order
statuses and payment methods; it is not a definition of net revenue. The agent
must clarify ambiguous metric definitions and report the sample's historical
window rather than silently substituting it for “last month.”

## Connect Slack

Run the channel setup to provision a Vercel Connect Slack connector and its
webhook at `/eve/v1/slack`:

```bash
pnpm exec eve add channel/slack
```

Keep the admission handlers in `agent/channels/slack.ts` if setup proposes to
replace the file. Set these values in `.env.local` and, when deployed, in the
Vercel project environment:

| Variable                    | Value                                                       |
| --------------------------- | ----------------------------------------------------------- |
| `SLACK_CONNECTOR`           | The connector UID from setup, such as `slack/company-brain` |
| `SLACK_TEAM_ID`             | The workspace ID                                            |
| `SLACK_ALLOWED_USER_IDS`    | Comma-separated user IDs allowed to ask questions           |
| `SLACK_ALLOWED_CHANNEL_IDS` | Comma-separated conversation IDs where the agent may answer |

All three access-policy values are required. Use exact IDs, not names or
wildcards. Include DM conversation IDs if you want DMs to work. Mentions, DMs,
interactive continuations, and the model tools check this policy. Other messages
are ignored; channel conversations require a mention to start another turn.

For a local webhook, Slack needs a publicly reachable development URL. Forward
only `/eve/v1/slack` when your tunnel supports path restrictions, and use HTTPS.
HTTP session routes still require operator credentials if the whole server is
forwarded. Deploy when you want Slack to reach a stable endpoint; the local
terminal UI does not need Slack configured.

**Every permitted conversation must be appropriate for the entire dataset.**
Replies appear in that conversation, where other members may read them. Choose
internal, non-shared conversations deliberately; the template does not check
Slack Connect membership, move sensitive results to DMs, or implement per-user
warehouse permissions. Everyone admitted uses the same warehouse identity.

The HTTP channel requires HTTP Basic operator credentials in development. An
unset or empty `COMPANY_BRAIN_HTTP_PASSWORD` disables HTTP access. Synthetic
`local-dev` identities cannot read models. Production HTTP access stays disabled,
even if the password is accidentally configured; Slack uses its own admission
policy.

## Use MotherDuck and deploy

1. Create a MotherDuck database named `jaffle_shop` and obtain a writer token.
2. Build the example there, using the writer token only for data preparation:

   ```bash
   DUCKDB_CONNECTION=md:jaffle_shop motherduck_token="$MOTHERDUCK_WRITER_TOKEN" pnpm data:build
   ```

3. Configure the deployed agent environment:

   ```dotenv
   DUCKDB_CONNECTION=md:jaffle_shop
   motherduck_token=your_read_scaling_token_here
   ```

   Use a [Read Scaling token](https://motherduck.com/docs/key-tasks/authenticating-and-connecting-to-motherduck/read-scaling/),
   not the writer token. Attach the intended database to its account using writer
   credentials before using the read token. Read replicas are eventually
   consistent and may lag writes by a few minutes. The template cannot verify
   the token's permissions; configuring read-only access is the operator's job.

4. Configure the Slack allowlists and model credentials, then deploy:

   ```bash
   pnpm exec eve deploy
   ```

Run the build on the deployment platform so the native DuckDB binding matches
its OS and architecture. `agent.ts` externalizes `@duckdb/node-api` so eve traces
its native dependency instead of bundling the binary as JavaScript. The Python
project, CSVs, and local database are not uploaded by the supplied `.vercelignore`;
Vercel builds the agent from the already-generated catalog.

Verify a Slack mention and a query against your deployment before using real
company data.

## How the data and catalog stay together

```text
CSV seeds → dbt build + tests → DuckDB file or MotherDuck tables
                    │
                    └→ dbt docs generate → agent/lib/catalog.ts
                                               │
Slack → eve agent → read model definitions ─────┘
              └→ constrained SQL → the selected database → threaded answer
```

`pnpm data:build` runs dbt and all its tests, then generates a compact catalog
from `manifest.json` and `catalog.json`. Only models tagged `company_brain` are
exposed. They must be materialized tables in `main`, with snake_case relation
names. The catalog includes descriptions, column types, compiled SQL, immediate
model dependencies, and authored `meta` values for grain, joins, metrics, and
caveats. A generated example catalog is included so an agent build does not need
Python or warehouse-write credentials.

Keep the generated catalog with the matching data release. Restart/rebuild the
agent after regenerating it. Stop the local agent before rebuilding the DuckDB
file: its cached read-only connection can prevent dbt opening a writer connection.
The catalog timestamp records metadata generation, not source-data freshness;
there is no automatic refresh or drift detection.

To use your company's models, replace the dbt project and enrich its descriptions
and `meta` definitions. Tag only the tables intended for this agent. Review model
SQL and catalog content before publishing; the catalog is trusted deployment
input, not a source of new runtime instructions.

## Query limits and boundaries

The query tool parses SQL with DuckDB's SQL serializer rather than a regex. It
accepts one SELECT with non-recursive CTEs and joins, checks table references in
CTE scope, and allows a fixed set of built-in analytical functions. It rejects
writes, multiple statements, raw/staging/system relations, metadata commands
such as `SHOW` and `DESCRIBE`, table functions, custom functions, dynamic pivots,
and recursive queries. Unknown table-reference forms are rejected.

Local database connections are read-only and disable external access. The tool
returns at most 200 rows, 32 columns, and 64 KiB of columns and row data, with an
explicit truncation flag. BIGINT/HUGEINT values are serialized as strings, and
dates use the DuckDB client's JSON representation. SQL is limited to 16 KiB. It allows
four concurrent queries per process and interrupts local work after 15 seconds
or when the calling turn is canceled. MotherDuck connection setup has a separate
10-second connection deadline. Cancellation of client work is not a guarantee
that remote execution or billing has stopped.

The local DuckDB instance uses two threads and a 256 MiB memory limit with no
disk spill. Those settings are not a resource budget for MotherDuck's remote
compute. Result limits do not limit the number of source rows scanned. Keep
model access narrow and configure warehouse cost controls for real deployments.
Backend errors are not returned verbatim to Slack. Native bindings and the
warehouse must remain trusted; this policy is not a general-purpose SQL sandbox.

The sample files come from the Apache 2.0-licensed dbt Jaffle Shop DuckDB example; see
[dbt/NOTICE.md](./dbt/NOTICE.md) for the pinned revision and attribution.
