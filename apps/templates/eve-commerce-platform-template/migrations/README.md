# Database setup

Connect a fresh PostgreSQL database. The template does not upgrade databases
from prototype branches. Copy any data you want to keep before replacing one.

Set `DATABASE_URL_UNPOOLED` to the direct database URL, then run:

```sh
pnpm db:migrate
```

Set `DATABASE_URL` for the build and running app. Vercel production builds
apply the schema before building. Preview builds skip the migration, not the
build-time database URL requirement: provision a separate preview database and
set its `DATABASE_URL` before the first build. Set `DATABASE_URL_UNPOOLED`
locally to that database’s direct URL when applying its migrations.

## Shopping watches

Migration `0002` replaces generic schedules with `shopping_watches`. It removes
legacy schedules and run history without converting them. Create new watches for
products you still want to track.

## Change the schema

Define tables in `lib/db/schema/` and export them from `lib/db/schema.ts`.
Generate SQL with `pnpm db:generate --name=describe-the-change`. Review and
commit the SQL, snapshot, and journal together.
