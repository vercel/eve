/**
 * Prepares the database during each Vercel build, so a fresh deploy works without running scripts by hand.
 *
 * Runs before `eve build` through the `vercel-build` script. With only `DATABASE_URL` set, it:
 * 1. Loads the demo data when `ANALYST_SEED_DEMO_DATA` is on and the demo schema is missing or stale.
 * 2. Creates or updates the read-only roles and the login, whose password is derived from the owner's password in `DATABASE_URL`.
 * The agent derives the same login at runtime, so no connection string needs copying. Failures are
 * logged and never fail the deploy; the agent then explains that setup isn't finished.
 *
 * @packageDocumentation
 */
import { Client } from "pg";
import { z } from "zod";

import {
  DEMO_SCHEMA,
  DERIVED_LOGIN,
  derivePassword,
  urlUser,
} from "#lib/analyst/derived-login";
import {
  inspectDemoSchema,
  loadDemoData,
  replacementBlocker,
} from "#scripts/seed/load";
import {
  needsDemoReload,
  planDeploySetup,
} from "#scripts/setup-on-deploy/plan";
import { buildSetupSql } from "#scripts/setup-sql/build";

const log = (message: string) => console.log(`[data analyst setup] ${message}`);

/* An error's message without its trailing period, so a sentence can follow it. */
const reason = (error: Error | string): string =>
  (error instanceof Error ? error.message : error).replace(/\.+$/u, "");

/** How long the deploy step waits for Postgres to accept a connection. */
const CONNECT_TIMEOUT_MS = 15_000;

const plan = planDeploySetup(process.env);
if (plan.action === "skip") {
  log(`Skipped: ${plan.reason}`);
  process.exit(0);
}

let client: Client | undefined;
try {
  // The constructor parses DATABASE_URL and reads certificate files, so it stays inside try.
  client = new Client({
    connectionString: plan.ownerUrl,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  // Without a listener, a dropped connection would crash the build instead of failing the next query.
  client.on("error", (error) => log(`Connection error: ${error.message}`));
  await client.connect();

  // A dot in the user name is either a connection pooler's routing suffix, which the agent's login keeps,
  // or part of the real name. Postgres sees the full name only in the second case.
  const owner = urlUser(plan.ownerUrl);
  let dottedOwner = false;
  if (owner.includes(".")) {
    const session = await client.query("SELECT session_user AS name");
    const [row] = z.array(z.object({ name: z.string() })).parse(session.rows);
    if (row?.name === owner) {
      dottedOwner = true;
      log(
        `The database user "${owner}" contains a dot, so the agent would connect as "${DERIVED_LOGIN}${owner.slice(owner.indexOf("."))}", which doesn't exist. Run \`ANALYST_LOGIN_PASSWORD=<new password> pnpm db:setup-sql --apply\` with this DATABASE_URL, set ANALYST_DATABASE_URL to the connection string it prints, and redeploy.`
      );
    }
  }

  if (plan.seedDemoData) {
    // A failed reload, such as a lock timeout, rolls back on its own and shouldn't stop the role setup below.
    try {
      const state = await inspectDemoSchema(client, DEMO_SCHEMA);
      const blocker = replacementBlocker(DEMO_SCHEMA, state);
      if (blocker) {
        log(
          `Demo data not loaded: ${blocker} Run \`pnpm db:seed --force\` to replace it.`
        );
      } else if (needsDemoReload(state?.anchorAt ?? null, new Date())) {
        await loadDemoData(client, DEMO_SCHEMA, state?.grantees ?? []);
        log("Demo data loaded.");
      } else {
        log("Demo data is current.");
      }
    } catch (error) {
      log(
        `Demo data not reloaded: ${reason(error instanceof Error ? error : String(error))}. The existing data, if any, is unchanged. Setting up roles next.`
      );
    }
  }

  if (plan.ignoredSchemas.length > 0) {
    log(
      `Ignored these schema names, which aren't valid or are shared without being listed in ANALYST_SCHEMAS: ${plan.ignoredSchemas.join(", ")}. Run \`pnpm db:doctor\` for details.`
    );
  }

  // GRANT fails on a schema that doesn't exist, so only grant the ones that do. Restricted schemas get no grants.
  const existing = await client.query(
    "SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)",
    [plan.sharedSchemas]
  );
  const found = new Set(
    z
      .array(z.object({ nspname: z.string() }))
      .parse(existing.rows)
      .map((row) => row.nspname)
  );
  const shared = plan.sharedSchemas.filter((schema) => found.has(schema));
  const missing = plan.sharedSchemas.filter((schema) => !found.has(schema));
  const restricted = plan.schemas.filter(
    (schema) => !plan.sharedSchemas.includes(schema)
  );
  if (missing.length > 0) {
    log(
      `These schemas don't exist yet and were skipped: ${missing.join(", ")}.`
    );
  }
  if (plan.sharedSchemas.length === 0) {
    log(
      "No usable shared schemas, so the read-only login wasn't set up. Each shared schema must be a valid name that ANALYST_SCHEMAS also lists. Run `pnpm db:doctor` to see which settings to fix, then redeploy."
    );
  } else if (shared.length === 0) {
    log(
      "No shared schemas to grant, so the read-only login wasn't set up. Set ANALYST_SCHEMAS, or ANALYST_SHARED_SCHEMAS if you use it, to schemas that exist, or turn on ANALYST_SEED_DEMO_DATA, then redeploy."
    );
  } else {
    await client.query(
      buildSetupSql({
        baseRole: plan.baseRole,
        login: DERIVED_LOGIN,
        password: derivePassword(plan.ownerUrl),
        schemas: plan.schemas,
        setPassword: true,
        sharedSchemas: shared,
        teamRoles: plan.teamRoles,
      })
    );
    log(
      `Read-only login ${DERIVED_LOGIN} is ready. Every role can read ${shared.join(", ")}.${
        restricted.length > 0
          ? ` Only roles you grant can read ${restricted.join(", ")}.`
          : ""
      }${
        dottedOwner
          ? " Set ANALYST_DATABASE_URL as described above, because the derived connection won't work."
          : " The agent derives its connection from DATABASE_URL."
      }`
    );
  }
} catch (error) {
  // Never fail the deploy: the agent explains what's missing, and the next deploy tries again.
  console.warn(
    `[data analyst setup] Setup didn't finish: ${reason(error instanceof Error ? error : String(error))}. Run \`pnpm db:doctor\` locally for details.`
  );
} finally {
  await client?.end().catch(() => null);
}
// Exit successfully even when setup didn't finish, so the deploy completes.
process.exitCode = 0;
