# Database

This directory owns the workspace application tables, the four Better
Auth tables, and the application domain query services. Better Auth uses the
canonical Drizzle client from `db/index.ts`; request paths never create or
migrate tables.

- `schema/` is the Drizzle source of truth.
- `index.ts` exports the Drizzle client and schema using pooled `DATABASE_URL`
  for request-time access.
- `services/` owns workspace-scoped application queries by domain.
- `drizzle.config.ts` uses `DATABASE_URL_UNPOOLED` for migration commands.
- `migrations/` is generated history. Run `pnpm db:generate` after changing the
  schema and commit the SQL, snapshot, and journal together.

Run `pnpm db:migrate` explicitly for local or operator-managed environments.
Vercel runs the uncached Turbo `db:migrate` task before `build:vercel`. The
package command delegates directly to `drizzle-kit migrate`. Migration commands
use `@next/env` to load the same root `.env*` precedence as Next.js; an injected
`DATABASE_URL_UNPOOLED` remains authoritative. Each Vercel environment must
therefore provide the direct URL for its intended database. Migrations must
remain backward compatible with the previously deployed application while a
rollout is in progress.

## Adopting an existing database

Migration `0000` supports both an empty database and one containing the tables
formerly created at request time. It preserves the existing text timestamp and
identifier representation, adds missing chat usage columns with safe defaults,
and installs new foreign keys and checks as `NOT VALID` when a table already
exists. PostgreSQL enforces those constraints for new writes immediately without
rejecting the deployment because of an unknown historical orphan.

Migration `0001` adopts the singular `user`, `session`, `account`, and
`verification` tables managed from `db/services/auth/index.ts`. It preserves the
existing `timestamptz` representation and rows, safely adds the nullable
phone-number plugin fields when absent, and installs the indexes used by Better
Auth. The runtime now assumes versioned migrations have run before requests are
served.

Before validating historical rows, back up the database and audit the pending
constraints:

```sql
SELECT conrelid::regclass AS table_name, conname
FROM pg_constraint
WHERE NOT convalidated
  AND connamespace = 'public'::regnamespace
ORDER BY 1, 2;
```

Repair any reported ownership or value violations, then validate each listed
constraint in a controlled maintenance step:

```sql
ALTER TABLE <table_name> VALIDATE CONSTRAINT <constraint_name>;
```

Validation is intentionally not automatic in the first deployment because it
scans existing rows and could turn unknown legacy drift into a production build
failure. Once all constraints are validated, their definitions already match
the canonical Drizzle schema; no data rewrite or separate Better Auth migration
is required outside the versioned Drizzle path.
