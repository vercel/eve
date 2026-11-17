/**
 * Checks that the analyst is configured and the database is locked down the way the agent assumes.
 *
 * Usage: pnpm db:doctor
 *
 * Exits non-zero when anything is unsafe or broken; warnings don't fail it.
 *
 * @packageDocumentation
 */
import { Client } from "pg";
import { z } from "zod";

import { parseAnalystConfig } from "#lib/analyst/config";
import type { AnalystConfig } from "#lib/analyst/config";
import {
  closePool,
  explainQuery,
  listTables,
  runReadOnlySql,
  withReadOnly,
} from "#lib/analyst/postgres";
import { DEMO_MARKER_TABLE } from "#scripts/seed/schema";
import { DEMO_DATA_MAX_AGE_MS } from "#scripts/setup-on-deploy/plan";

type Status = "fail" | "pass" | "warn";

/** How long the doctor waits for Postgres to accept a connection. */
const CONNECT_TIMEOUT_MS = 15_000;

let failures = 0;
const report = (status: Status, message: string) => {
  if (status === "fail") {
    failures += 1;
  }
  console.log(`${{ fail: "✗", pass: "✓", warn: "!" }[status]} ${message}`);
};

const failure = (error: Error | string): string =>
  error instanceof Error ? error.message : error;

const loginSchema = z.object({
  can_create: z.boolean(),
  direct_grants: z.coerce.number(),
  login: z.string(),
  read_only_default: z.string(),
  rolbypassrls: z.boolean(),
  rolcreatedb: z.boolean(),
  rolcreaterole: z.boolean(),
  rolsuper: z.boolean(),
  set_config_public: z.boolean(),
  timezone_known: z.boolean(),
});

/* Restricted schemas where the base role still has a USAGE grant, can read tables, or will get new ones, for example from when the schema was shared. */
const checkRestrictedSchemas = async (
  client: Client,
  config: AnalystConfig
) => {
  // Setup still creates the base role in allowlist mode, and team roles inherit it.
  const baseRole = config.ANALYST_DEFAULT_ROLE || "analyst_readonly";
  const restricted = config.ANALYST_SCHEMAS.filter(
    (schema) => !config.ANALYST_SHARED_SCHEMAS.includes(schema)
  );
  if (restricted.length === 0) {
    return;
  }
  const result = await client.query(
    `SELECT n.nspname AS schema
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.rolname = $2
      WHERE n.nspname = ANY($1)
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND has_table_privilege(r.oid, c.oid, 'SELECT')
     UNION
     SELECT n.nspname
       FROM pg_default_acl d
       JOIN pg_namespace n ON n.oid = d.defaclnamespace
       JOIN pg_roles r ON r.rolname = $2
      WHERE n.nspname = ANY($1)
        AND d.defaclobjtype = 'r'
        AND EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a
                     WHERE a.grantee = r.oid AND a.privilege_type = 'SELECT')
     UNION
     -- The base role's own USAGE grant, which REVOKE removes. USAGE that PUBLIC holds, as on the public schema, isn't counted.
     SELECT n.nspname
       FROM pg_namespace n
       JOIN pg_roles r ON r.rolname = $2
      WHERE n.nspname = ANY($1)
        AND EXISTS (SELECT 1 FROM aclexplode(n.nspacl) a
                     WHERE a.grantee = r.oid AND a.privilege_type = 'USAGE')
     ORDER BY 1`,
    [restricted, baseRole]
  );
  const open = z
    .array(z.object({ schema: z.string() }))
    .parse(result.rows)
    .map((row) => row.schema);
  if (open.length > 0) {
    const list = open.join(", ");
    report(
      "warn",
      `${baseRole} still has access to ${list}, though ANALYST_SHARED_SCHEMAS leaves them out, so every role can read their tables or call their functions. As the database owner, run: REVOKE SELECT ON ALL TABLES IN SCHEMA ${list} FROM ${baseRole}; REVOKE USAGE ON SCHEMA ${list} FROM ${baseRole}; ALTER DEFAULT PRIVILEGES IN SCHEMA ${list} REVOKE SELECT ON TABLES FROM ${baseRole};`
    );
  } else {
    report("pass", `Only roles you grant can read ${restricted.join(", ")}`);
  }
};

const checkLogin = async (config: AnalystConfig, roles: readonly string[]) => {
  const client = new Client({
    connectionString: config.ANALYST_DATABASE_URL,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT current_user AS login, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls,
              current_setting('default_transaction_read_only') AS read_only_default,
              has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
              (SELECT count(*) FROM information_schema.role_table_grants g
                WHERE g.grantee = current_user AND g.table_schema = ANY($1)) AS direct_grants,
              EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $2) OR $2 = 'UTC' AS timezone_known,
              has_function_privilege('public', 'pg_catalog.set_config(text, text, boolean)', 'EXECUTE') AS set_config_public
         FROM pg_roles r WHERE r.rolname = current_user`,
      [config.ANALYST_SCHEMAS, config.ANALYST_TIMEZONE]
    );
    const login = loginSchema.parse(result.rows[0]);
    report("pass", `Connected as ${login.login}`);
    if (login.rolsuper || login.rolcreaterole || login.rolbypassrls) {
      report(
        "fail",
        `${login.login} is a superuser or can create roles or bypass row-level security. Connect with the dedicated login from \`pnpm db:setup-sql\`.`
      );
    }
    if (login.direct_grants > 0) {
      report(
        "fail",
        `${login.login} has direct grants on ${config.ANALYST_SCHEMAS.join(", ")}. The login must read nothing on its own; grant access to the analyst roles instead.`
      );
    }
    if (login.read_only_default !== "on") {
      report(
        "warn",
        `default_transaction_read_only is off for ${login.login}. The agent still uses READ ONLY transactions, but turn it on as a backstop.`
      );
    }
    if (login.can_create || login.rolcreatedb) {
      report(
        "warn",
        `${login.login} can create schemas or databases. Consider revoking CREATE.`
      );
    }
    if (login.timezone_known) {
      report(
        "pass",
        `Reporting time zone ${config.ANALYST_TIMEZONE} is known to Postgres`
      );
    } else {
      report(
        "fail",
        `Postgres doesn't recognize ANALYST_TIMEZONE=${config.ANALYST_TIMEZONE}.`
      );
    }
    if (roles.length > 1 && login.set_config_public) {
      report(
        "warn",
        `ANALYST_ROLE_MAP uses ${roles.length} roles, and every role can still call set_config(). Queries can switch between these roles through functions the agent can't fully block, so one team could read another team's tables. For real isolation, give each team its own deployment and database user, or revoke set_config() from PUBLIC, as "Separate teams completely" in CUSTOMIZATION.md describes.`
      );
    }
    try {
      await checkRestrictedSchemas(client, config);
    } catch (error) {
      report(
        "warn",
        `Couldn't check restricted schemas: ${failure(error instanceof Error ? error : String(error))}`
      );
    }
    for (const role of roles) {
      const membership = await client.query(
        `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists,
                COALESCE((SELECT pg_has_role(current_user, oid, 'MEMBER') FROM pg_roles WHERE rolname = $1), false) AS can_set`,
        [role]
      );
      const { can_set: canSet, exists } = z
        .object({ can_set: z.boolean(), exists: z.boolean() })
        .parse(membership.rows[0]);
      if (!exists) {
        report(
          "fail",
          `Role ${role} doesn't exist. Run \`pnpm db:setup-sql --apply\`.`
        );
      } else if (!canSet) {
        report(
          "fail",
          `${login.login} can't SET ROLE ${role}. Run: GRANT ${role} TO ${login.login};`
        );
      }
    }
  } finally {
    await client.end();
  }
};

const checkRole = async (config: AnalystConfig, role: string) => {
  const writable = await withReadOnly(role, async (client) => {
    const result = await client.query({
      text: `SELECT DISTINCT table_schema || '.' || table_name AS name
               FROM information_schema.role_table_grants
              WHERE grantee IN (SELECT rolname FROM pg_roles WHERE pg_has_role($1, oid, 'MEMBER'))
                AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
                AND table_schema = ANY($2)
              LIMIT 5`,
      values: [role, config.ANALYST_SCHEMAS],
    });
    return z
      .array(z.object({ name: z.string() }))
      .parse(result.rows)
      .map((row) => row.name);
  });
  if (writable.length > 0) {
    report(
      "warn",
      `${role} has write grants on ${writable.join(", ")}. Queries still run in READ ONLY transactions, but grant SELECT only.`
    );
  }
  await runReadOnlySql("SELECT 1 AS ok", role);
  const { tables } = await listTables(role);
  if (tables.length === 0) {
    report(
      "warn",
      `${role} can't see any tables in ${config.ANALYST_SCHEMAS.join(", ")}.`
    );
    return tables;
  }
  report("pass", `${role} can query ${tables.length} table(s)`);
  return tables;
};

const checkDemoData = async (config: AnalystConfig) => {
  const ageMs = await withReadOnly(
    config.ANALYST_DEFAULT_ROLE || "analyst_readonly",
    async (client) => {
      const marker = await client.query({
        text: "SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = $2 AND n.nspname = ANY($1) LIMIT 1",
        values: [config.ANALYST_SCHEMAS, DEMO_MARKER_TABLE],
      });
      const [row] = z
        .array(z.object({ schema: z.string() }))
        .parse(marker.rows);
      if (!row) {
        return;
      }
      // Same rule as the deploy step: the age of the marker's anchor time, computed in SQL.
      const latest = await client.query({
        text: `SELECT (extract(epoch FROM now() - max(anchor_at)) * 1000)::bigint AS age_ms FROM ${row.schema}.${DEMO_MARKER_TABLE}`,
      });
      return (
        z
          .array(z.object({ age_ms: z.coerce.number().nullable() }))
          .parse(latest.rows)[0]?.age_ms ?? null
      );
    }
  );
  if (ageMs === undefined) {
    return;
  }
  // The exact opposite of needsDemoReload, which reloads when the age is above the limit.
  if (ageMs !== null && ageMs <= DEMO_DATA_MAX_AGE_MS) {
    const days = Math.floor(ageMs / 86_400_000);
    report(
      "pass",
      `Demo data is current (generated ${days === 0 ? "today" : `${days} day(s) ago`})`
    );
  } else {
    report(
      "warn",
      "The demo data is more than a week old, so questions about recent periods will come back empty. Redeploy, or run `pnpm db:seed`."
    );
  }
};

const suggestThreshold = async (
  config: AnalystConfig,
  tables: readonly { approxRows: number | null; name: string }[]
) => {
  const role = config.ANALYST_DEFAULT_ROLE;
  const [largest] = tables.toSorted(
    (a, b) => (b.approxRows ?? 0) - (a.approxRows ?? 0)
  );
  if (!(role && largest)) {
    return;
  }
  // Aggregate, so the row cap on raw results doesn't hide the cost of reading the whole table.
  const { totalCost } = await explainQuery(
    `SELECT count(*) FROM ${largest.name}`,
    role
  );
  const suggested = Math.max(100, Math.round(totalCost / 2));
  if (config.ANALYST_APPROVAL_COST > totalCost) {
    report(
      "warn",
      `A full scan of ${largest.name} (about ${(largest.approxRows ?? 0).toLocaleString()} rows) costs ${Math.round(totalCost).toLocaleString()}, below ANALYST_APPROVAL_COST (${config.ANALYST_APPROVAL_COST.toLocaleString()}), so only very expensive queries such as large joins will ask for approval. Set it to about ${suggested.toLocaleString()} to also gate queries that read the whole table.`
    );
  } else {
    report(
      "pass",
      `A full scan of ${largest.name} costs ${Math.round(totalCost).toLocaleString()}; queries above ${config.ANALYST_APPROVAL_COST.toLocaleString()} ask for approval`
    );
  }
};

const main = async () => {
  let config: AnalystConfig;
  try {
    config = parseAnalystConfig(process.env);
    report("pass", "Environment variables are valid");
    if (!process.env.ANALYST_DATABASE_URL?.trim()) {
      report(
        "pass",
        "Using the read-only login derived from DATABASE_URL (the deploy step creates it)"
      );
    }
  } catch (error) {
    report("fail", failure(error instanceof Error ? error : String(error)));
    return;
  }
  const roles = [
    ...new Set([
      config.ANALYST_DEFAULT_ROLE,
      ...Object.values(config.ANALYST_ROLE_MAP),
    ]),
  ].filter(Boolean);
  try {
    await checkLogin(config, roles);
  } catch (error) {
    report(
      "fail",
      `Couldn't connect to Postgres: ${failure(error instanceof Error ? error : String(error))}`
    );
    return;
  }
  let tables: { approxRows: number | null; name: string }[] = [];
  for (const role of roles) {
    try {
      const visible = await checkRole(config, role);
      if (role === config.ANALYST_DEFAULT_ROLE) {
        tables = visible;
      }
    } catch (error) {
      report(
        "fail",
        `${role}: ${failure(error instanceof Error ? error : String(error))}`
      );
    }
  }
  try {
    await checkDemoData(config);
    await suggestThreshold(config, tables);
  } catch (error) {
    report(
      "warn",
      `Couldn't check data freshness or the approval threshold: ${failure(error instanceof Error ? error : String(error))}`
    );
  }
  const connector = process.env.SLACK_CONNECTOR;
  if (!connector || connector === "slack/placeholder") {
    report(
      "warn",
      "SLACK_CONNECTOR isn't set to a real connector, so the agent only works through the HTTP API and `eve dev`. Run `pnpm exec eve add channel/slack`."
    );
  }
};

try {
  await main();
} finally {
  await closePool();
}
console.log(failures > 0 ? `\n${failures} problem(s) to fix.` : "\nReady.");
process.exit(failures > 0 ? 1 : 0);
