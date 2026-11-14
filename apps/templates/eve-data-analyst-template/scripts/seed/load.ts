/**
 * Inspects, loads, and summarizes the demo schema; shared by `pnpm db:seed` and the deploy step.
 *
 * @packageDocumentation
 */
import { setTimeout as delay } from "node:timers/promises";

import type { ClientBase } from "pg";
import { z } from "zod";

import { isSafeIdentifier } from "#lib/analyst/identifiers";
import { generateDemoData } from "#scripts/seed/generate";
import type { DemoData } from "#scripts/seed/generate";
import {
  DEMO_MARKER_TABLE,
  DEMO_SCHEMA_VERSION,
  DEMO_TABLES,
  demoSchemaStatements,
} from "#scripts/seed/schema";
import { mrrLastMonthSql, topSourcesLast10DaysSql } from "#scripts/seed/sql";

/**
 * The part of a pg client that loading demo data uses.
 *
 * @remarks A pg `Client` or `PoolClient` satisfies it. Tests pass a fake that records each statement.
 */
export interface SeedClient {
  readonly query: (
    text: string,
    values?: readonly unknown[]
  ) => Promise<{ readonly rows: readonly unknown[] }>;
}

/** Overrides for {@link loadDemoData}. */
export interface LoadOptions {
  /**
   * Replace the schema even when other objects were added to it or depend on it, dropping them with `CASCADE`.
   * @remarks Defaults to false. `db:seed --force` sets it; the deploy step never does.
   */
  readonly force?: boolean;
  /** Waits between swap attempts. Tests pass one that resolves at once. */
  readonly pause?: (ms: number) => Promise<void>;
}

const BATCH_SIZE = 5000;

/** A value bound into an insert parameter array. */
type CellValue = boolean | Date | number | string | null;

/* A column of `Row` and its Postgres type, so a misspelled column name fails to compile. */
type RowColumn<Row> = readonly [name: keyof Row & string, type: string];

/* Inserts rows with one parameter array per column, so each batch is a single statement. */
const insert = async <Row extends { readonly [K in keyof Row]: CellValue }>(
  client: SeedClient,
  schema: string,
  table: string,
  columns: readonly RowColumn<NoInfer<Row>>[],
  rows: readonly Row[]
) => {
  const names = columns.map(([name]) => name).join(", ");
  const arrays = columns
    .map(([, type], index) => `$${index + 1}::${type}[]`)
    .join(", ");
  const started = Date.now();
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    await client.query(
      `INSERT INTO ${schema}.${table} (${names}) SELECT * FROM unnest(${arrays})`,
      columns.map(([name]) => batch.map((row) => row[name]))
    );
  }
  console.log(
    `  ${table}: ${rows.length.toLocaleString()} rows (${((Date.now() - started) / 1000).toFixed(1)}s)`
  );
};

/* Assigns 1-based codes to repeated values, so each batch uploads small integers plus one short dictionary. */
const encoder = () => {
  const codes = new Map<string, number>();
  const values: string[] = [];
  return {
    code(key: string) {
      let code = codes.get(key);
      if (code === undefined) {
        values.push(key);
        code = values.length;
        codes.set(key, code);
      }
      return code;
    },
    values,
  };
};

const SESSION_BATCH_SIZE = 25_000;

/* One parameter array per encoded session column. */
interface SessionColumns {
  readonly bot: boolean[];
  readonly country: number[];
  readonly device: number[];
  readonly landing: number[];
  readonly pageviews: number[];
  readonly seconds: number[];
  readonly traffic: number[];
}

/**
 * Uploads web sessions in a compact form and expands it in SQL.
 *
 * @param client - Connection inside the seed transaction.
 * @param schema - Validated demo schema name.
 * @param data - Generated demo data; session IDs must be consecutive.
 * @remarks Sessions are most of the demo data. Sending traffic attributes, landing pages, countries, and devices as dictionary codes, timestamps as second offsets, and deriving the visitor ID and duration in SQL cuts the upload by about 85%, which matters on slow links to a hosted database.
 */
const insertWebSessions = async (
  client: SeedClient,
  schema: string,
  data: DemoData
) => {
  const rows = data.webSessions;
  const base = Math.floor((rows[0]?.started_at.getTime() ?? 0) / 1000);
  const started = Date.now();
  for (let offset = 0; offset < rows.length; offset += SESSION_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + SESSION_BATCH_SIZE);
    const firstId = batch[0]?.session_id ?? 0;
    const traffic = encoder();
    const landing = encoder();
    const country = encoder();
    const device = encoder();
    const columns: SessionColumns = {
      bot: [],
      country: [],
      device: [],
      landing: [],
      pageviews: [],
      seconds: [],
      traffic: [],
    };
    for (const [index, row] of batch.entries()) {
      if (row.session_id !== firstId + index) {
        throw new Error("Web session IDs must be consecutive.");
      }
      columns.seconds.push(Math.floor(row.started_at.getTime() / 1000) - base);
      columns.traffic.push(
        traffic.code(
          JSON.stringify([
            row.source,
            row.medium,
            row.channel_group,
            row.referrer_domain,
            row.utm_source,
            row.utm_medium,
            row.utm_campaign,
          ])
        )
      );
      columns.landing.push(landing.code(row.landing_page));
      columns.country.push(country.code(row.country));
      columns.device.push(device.code(row.device));
      columns.pageviews.push(row.pageviews);
      columns.bot.push(row.is_bot);
    }
    const attributes = z
      .array(
        z.tuple([
          z.string(),
          z.string(),
          z.string(),
          z.string().nullable(),
          z.string().nullable(),
          z.string().nullable(),
          z.string().nullable(),
        ])
      )
      .parse(traffic.values.map((key) => JSON.parse(key)));
    await client.query(
      `INSERT INTO ${schema}.web_sessions (session_id, anonymous_id, started_at, landing_page, referrer_domain,
         utm_source, utm_medium, utm_campaign, source, medium, channel_group, device, country, pageviews,
         duration_seconds, is_bot)
       SELECT u.id,
              'anon_' || ((hashint8(u.id)::bigint & 2147483647) % 400000)::text,
              to_timestamp($2::bigint + u.seconds),
              lp.value, tr.referrer_domain, tr.utm_source, tr.utm_medium, tr.utm_campaign,
              tr.source, tr.medium, tr.channel_group, dv.value, ct.value, u.pageviews,
              CASE WHEN u.bot THEN 0 ELSE u.pageviews * (20 + (hashint8(u.id + 1)::bigint & 2147483647) % 90) END,
              u.bot
         FROM (SELECT $1::bigint + ord - 1 AS id, seconds, traffic, landing, country, device, pageviews, bot
                 FROM unnest($3::integer[], $4::smallint[], $5::smallint[], $6::smallint[], $7::smallint[], $8::smallint[], $9::boolean[])
                      WITH ORDINALITY AS t(seconds, traffic, landing, country, device, pageviews, bot, ord)) u
         JOIN unnest($10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[], $16::text[])
              WITH ORDINALITY AS tr(source, medium, channel_group, referrer_domain, utm_source, utm_medium, utm_campaign, code)
           ON tr.code = u.traffic
         JOIN unnest($17::text[]) WITH ORDINALITY AS lp(value, code) ON lp.code = u.landing
         JOIN unnest($18::text[]) WITH ORDINALITY AS ct(value, code) ON ct.code = u.country
         JOIN unnest($19::text[]) WITH ORDINALITY AS dv(value, code) ON dv.code = u.device`,
      [
        firstId,
        base,
        columns.seconds,
        columns.traffic,
        columns.landing,
        columns.country,
        columns.device,
        columns.pageviews,
        columns.bot,
        ...[0, 1, 2, 3, 4, 5, 6].map((position) =>
          attributes.map((tuple) => tuple[position] ?? null)
        ),
        landing.values,
        country.values,
        device.values,
      ]
    );
    const done = Math.min(offset + SESSION_BATCH_SIZE, rows.length);
    if (done < rows.length) {
      console.log(
        `  web_sessions: ${done.toLocaleString()} of ${rows.length.toLocaleString()} rows…`
      );
    }
  }
  console.log(
    `  web_sessions: ${rows.length.toLocaleString()} rows (${((Date.now() - started) / 1000).toFixed(1)}s)`
  );
};

const insertAll = async (
  client: SeedClient,
  schema: string,
  data: DemoData
) => {
  await insert(
    client,
    schema,
    "plans",
    [
      ["plan_id", "text"],
      ["name", "text"],
      ["monthly_price_cents", "integer"],
      ["annual_price_cents", "integer"],
    ],
    data.plans
  );
  await insert(
    client,
    schema,
    "customers",
    [
      ["customer_id", "bigint"],
      ["company_name", "text"],
      ["email_domain", "text"],
      ["country", "text"],
      ["industry", "text"],
      ["segment", "text"],
      ["acquisition_source", "text"],
      ["signed_up_at", "timestamptz"],
      ["is_internal", "boolean"],
    ],
    data.customers
  );
  await insert(
    client,
    schema,
    "subscriptions",
    [
      ["subscription_id", "bigint"],
      ["customer_id", "bigint"],
      ["plan_id", "text"],
      ["billing_interval", "text"],
      ["mrr_cents", "integer"],
      ["status", "text"],
      ["trial_started_at", "timestamptz"],
      ["trial_ends_at", "timestamptz"],
      ["started_at", "timestamptz"],
      ["canceled_at", "timestamptz"],
      ["ended_at", "timestamptz"],
    ],
    data.subscriptions
  );
  await insert(
    client,
    schema,
    "invoices",
    [
      ["invoice_id", "bigint"],
      ["customer_id", "bigint"],
      ["subscription_id", "bigint"],
      ["status", "text"],
      ["total_cents", "integer"],
      ["period_start", "timestamptz"],
      ["period_end", "timestamptz"],
      ["issued_at", "timestamptz"],
    ],
    data.invoices
  );
  await insert(
    client,
    schema,
    "payments",
    [
      ["payment_id", "bigint"],
      ["invoice_id", "bigint"],
      ["customer_id", "bigint"],
      ["amount_cents", "integer"],
      ["status", "text"],
      ["method", "text"],
      ["created_at", "timestamptz"],
    ],
    data.payments
  );
  await insert(
    client,
    schema,
    "refunds",
    [
      ["refund_id", "bigint"],
      ["payment_id", "bigint"],
      ["customer_id", "bigint"],
      ["amount_cents", "integer"],
      ["reason", "text"],
      ["created_at", "timestamptz"],
    ],
    data.refunds
  );
  await insertWebSessions(client, schema, data);
  await insert(
    client,
    schema,
    "signups",
    [
      ["signup_id", "bigint"],
      ["session_id", "bigint"],
      ["customer_id", "bigint"],
      ["signed_up_at", "timestamptz"],
    ],
    data.signups
  );
  // Mark the session each account signed up in; done here so the bulk upload needn't carry it.
  await client.query(
    `UPDATE ${schema}.web_sessions w SET customer_id = g.customer_id FROM ${schema}.signups g WHERE g.session_id = w.session_id`
  );
};

/** What exists in a schema the seed might replace. */
export interface DemoSchemaState {
  /** When the current demo data was generated up to, if the schema holds demo data. */
  readonly anchorAt: Date | null;
  /** Objects in other schemas that `DROP SCHEMA ... CASCADE` would also drop. */
  readonly dependents: readonly string[];
  /** Roles with direct read access, re-granted after a reload. */
  readonly grantees: readonly string[];
  /** Whether the schema carries the seed's marker table, owned by the current role. */
  readonly marked: boolean;
  /** Tables, views, and other relations in the schema that the seed didn't create. */
  readonly others: readonly string[];
}

const stateSchema = z.object({
  dependents: z.array(z.string()),
  grantees: z.array(z.string()).nullable(),
  marked: z.boolean(),
  others: z.array(z.string()),
});

/**
 * Reads what the seed would replace in a schema.
 *
 * @param client - Connection as the role that will run the seed.
 * @param schema - Validated schema name.
 * @returns The schema's state, or null when it doesn't exist.
 */
export const inspectDemoSchema = async (
  client: SeedClient,
  schema: string
): Promise<DemoSchemaState | null> => {
  const result = await client.query(
    `SELECT EXISTS (
              SELECT 1 FROM pg_class c
               WHERE c.relnamespace = n.oid AND c.relname = $3 AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
            ) AS marked,
            ARRAY(
              SELECT c.relname::text FROM pg_class c
               WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.relname <> ALL($2)
            ) AS others,
            ARRAY(
              SELECT DISTINCT dn.nspname || '.' || dc.relname
                FROM pg_depend d
                JOIN pg_rewrite rw ON d.classid = 'pg_rewrite'::regclass AND rw.oid = d.objid
                JOIN pg_class dc ON dc.oid = rw.ev_class
                JOIN pg_namespace dn ON dn.oid = dc.relnamespace
                JOIN pg_class rc ON d.refclassid = 'pg_class'::regclass AND rc.oid = d.refobjid
               WHERE rc.relnamespace = n.oid AND dc.relnamespace <> n.oid
              UNION
              SELECT DISTINCT cn.nspname || '.' || cc.relname
                FROM pg_constraint con
                JOIN pg_class cc ON cc.oid = con.conrelid
                JOIN pg_namespace cn ON cn.oid = cc.relnamespace
                JOIN pg_class fc ON fc.oid = con.confrelid
               WHERE con.contype = 'f' AND fc.relnamespace = n.oid AND cc.relnamespace <> n.oid
            ) AS dependents,
            (SELECT array_agg(DISTINCT a.grantee::regrole::text)
               FROM aclexplode(n.nspacl) a
              WHERE a.privilege_type = 'USAGE' AND a.grantee <> n.nspowner AND a.grantee <> 0) AS grantees
       FROM pg_namespace n
      WHERE n.nspname = $1`,
    [schema, [...DEMO_TABLES, DEMO_MARKER_TABLE], DEMO_MARKER_TABLE]
  );
  const [row] = z.array(stateSchema).parse(result.rows);
  if (!row) {
    return null;
  }
  let anchorAt: Date | null = null;
  if (row.marked) {
    const anchor = await client.query(
      `SELECT max(anchor_at) AS anchor_at FROM ${schema}.${DEMO_MARKER_TABLE}`
    );
    anchorAt =
      z
        .array(z.object({ anchor_at: z.date().nullable() }))
        .parse(anchor.rows)[0]?.anchor_at ?? null;
  }
  return { ...row, anchorAt, grantees: row.grantees ?? [] };
};

/**
 * Explains why the seed must not replace a schema without `--force`.
 *
 * @param schema - Schema name, for the message.
 * @param state - What the schema holds, or null when it doesn't exist.
 * @returns A reason to refuse, or null when replacing it only affects demo data.
 */
export const replacementBlocker = (
  schema: string,
  state: DemoSchemaState | null
): string | null => {
  if (!state) {
    return null;
  }
  // Without --force the swap refuses these too, but checking first explains why before the load starts.
  if (state.dependents.length > 0) {
    return `Objects outside "${schema}" depend on it and would be dropped too: ${state.dependents.join(", ")}.`;
  }
  if (!state.marked) {
    return `Schema "${schema}" already exists and wasn't created by db:seed as this role.`;
  }
  if (state.others.length > 0) {
    return `Schema "${schema}" also contains objects db:seed didn't create (${state.others.join(", ")}).`;
  }
  return null;
};

/** The anchor time and rows from one load. */
export interface LoadedDemoData {
  readonly anchor: Date;
  readonly data: DemoData;
}

/**
 * Schema the seed builds new demo data in before swapping it in.
 *
 * @remarks It exists only inside the seed transaction. The advisory lock means two loads never use it at once.
 */
export const DEMO_STAGING_SCHEMA = "eve_demo_staging";

/** How long each swap attempt waits for a lock held by running queries on the old demo tables. */
const SWAP_LOCK_TIMEOUT = "5s";

/** Swap attempts before the load gives up and rolls back. */
const SWAP_ATTEMPTS = 3;

/** Pause between swap attempts, so long-running readers can finish. */
const SWAP_RETRY_DELAY_MS = 2000;

/* Postgres reports a lock_timeout as SQLSTATE 55P03, lock_not_available. */
const isLockTimeout = (error: unknown): error is { code: "55P03" } =>
  z.object({ code: z.literal("55P03") }).safeParse(error).success;

/* Postgres refuses a DROP without CASCADE with SQLSTATE 2BP01, dependent_objects_still_exist, and lists the objects in the detail. */
const dependentObjects = z.object({
  code: z.literal("2BP01"),
  detail: z.string().optional(),
});

/* Explains a refused swap, listing what Postgres would have dropped. */
const refusedSwap = (schema: string, detail: string | undefined) =>
  new Error(
    `Objects were added to "${schema}", or now depend on it, so the demo data wasn't replaced${
      detail ? ` (${detail.split("\n").join("; ")})` : ""
    }. Run \`pnpm db:seed --force\` to replace it anyway, which drops them.`
  );

/**
 * Builds the statements that drop the live demo schema.
 *
 * @param schema - Validated schema name.
 * @param force - Whether to drop objects that were added to the schema or depend on it.
 * @returns Statements to run in order.
 * @remarks Without `force`, the seed's own tables are dropped by name and the schema with the default `RESTRICT`, so Postgres refuses when anything else is in the schema or depends on it, such as a view or a table created while the data loaded. The check happens under the drop's own locks, so nothing created earlier can slip through.
 */
const dropDemoSchemaStatements = (schema: string, force: boolean): string[] =>
  force
    ? [`DROP SCHEMA IF EXISTS ${schema} CASCADE`]
    : [
        // One statement, so foreign keys between the demo tables don't block it.
        `DROP TABLE IF EXISTS ${[...DEMO_TABLES, DEMO_MARKER_TABLE].map((table) => `${schema}.${table}`).join(", ")}`,
        `DROP SCHEMA IF EXISTS ${schema}`,
      ];

/* Drops the live schema and renames the staging schema into its place, retrying when running queries hold a lock. */
const swapIntoPlace = async (
  client: SeedClient,
  schema: string,
  force: boolean,
  pause: (ms: number) => Promise<void>
) => {
  // Set once, before the first savepoint: rolling back to a savepoint would undo a SET LOCAL made after it.
  await client.query(`SET LOCAL lock_timeout = '${SWAP_LOCK_TIMEOUT}'`);
  for (let attempt = 1; ; attempt += 1) {
    await client.query("SAVEPOINT swap");
    try {
      for (const statement of dropDemoSchemaStatements(schema, force)) {
        await client.query(statement);
      }
      await client.query(
        `ALTER SCHEMA ${DEMO_STAGING_SCHEMA} RENAME TO ${schema}`
      );
      await client.query("RELEASE SAVEPOINT swap");
      return;
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT swap");
      const refused = dependentObjects.safeParse(error);
      if (refused.success) {
        throw refusedSwap(schema, refused.data.detail);
      }
      if (attempt >= SWAP_ATTEMPTS || !isLockTimeout(error)) {
        throw error;
      }
      console.log(
        `Queries are still reading "${schema}". Trying again (attempt ${attempt + 1} of ${SWAP_ATTEMPTS})…`
      );
      await pause(SWAP_RETRY_DELAY_MS);
    }
  }
};

/**
 * Replaces the schema with freshly generated demo data in one transaction.
 *
 * @param client - Owner connection.
 * @param schema - Validated schema name; callers check {@link replacementBlocker} first.
 * @param grantees - Roles that read the old schema, given the same read access to the new one.
 * @param options - Whether to force the replacement, and the pause between swap attempts.
 * @returns The anchor time and generated rows.
 * @throws {@link Error} When `schema` is the staging schema, when a schema with the staging name already exists, when the swap still can't get its locks after the last attempt, or, without `force`, when the live schema holds objects the seed didn't create or other objects depend on it. The transaction rolls back, so the old data stays in place.
 * @remarks The data loads into {@link DEMO_STAGING_SCHEMA}, gets its grants and planner statistics there, and only then replaces the live schema with the statements from {@link dropDemoSchemaStatements} and `ALTER SCHEMA ... RENAME`. Without `force`, that drop refuses anything the seed didn't create, including objects added while the data loaded. The old tables stay readable during the load, and the swap holds their locks for milliseconds. The swap waits at most `lock_timeout` for each lock, and is retried from a savepoint a few times. An advisory lock serializes concurrent loads, such as two deploys at once.
 */
export const loadDemoData = async (
  client: SeedClient,
  schema: string,
  grantees: readonly string[],
  { force = false, pause = delay }: LoadOptions = {}
): Promise<LoadedDemoData> => {
  if (schema === DEMO_STAGING_SCHEMA) {
    throw new Error(
      `"${DEMO_STAGING_SCHEMA}" is reserved for loading demo data. Choose another schema.`
    );
  }
  const anchor = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  console.log(`Generating demo data through ${anchor.toISOString()}…`);
  const data = generateDemoData({ anchor });
  console.log(
    `Loading into "${schema}". This takes a minute or two on a remote database, and nothing changes until it finishes.`
  );
  const staging = DEMO_STAGING_SCHEMA;
  try {
    await client.query("BEGIN");
    // Bounds every statement, including the advisory lock wait, whatever timeout the owner role has.
    await client.query("SET LOCAL statement_timeout = '5min'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('eve-data-analyst demo seed'))"
    );
    const leftover = await client.query(
      "SELECT 1 FROM pg_namespace WHERE nspname = $1",
      [staging]
    );
    if (leftover.rows.length > 0) {
      throw new Error(
        `Schema "${staging}" already exists. db:seed builds demo data there before swapping it in, so drop or rename it first.`
      );
    }
    // One round trip: the simple protocol runs the trusted DDL statements in order.
    await client.query(demoSchemaStatements(staging).join(";\n"));
    await insertAll(client, staging, data);
    await client.query(
      `INSERT INTO ${staging}.${DEMO_MARKER_TABLE} (version, anchor_at) VALUES ($1, $2)`,
      [DEMO_SCHEMA_VERSION, anchor]
    );
    // The new schema starts without grants; give roles that read the old one the same access.
    for (const grantee of grantees) {
      if (isSafeIdentifier(grantee)) {
        await client.query(`GRANT USAGE ON SCHEMA ${staging} TO ${grantee}`);
        await client.query(
          `GRANT SELECT ON ALL TABLES IN SCHEMA ${staging} TO ${grantee}`
        );
        await client.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${staging} GRANT SELECT ON TABLES TO ${grantee}`
        );
      }
    }
    // ANALYZE works inside a transaction, so the tables never go live without planner statistics.
    // The schema overview and the approval cost gate depend on them.
    console.log("Updating planner statistics…");
    await client.query(
      `ANALYZE ${DEMO_TABLES.map((table) => `${staging}.${table}`).join(", ")}`
    );
    await swapIntoPlace(client, schema, force, pause);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  }
  return { anchor, data };
};

/** Expected answers for the demo questions. */
export interface DemoSummary {
  readonly monthStart: string;
  readonly mrr: string;
  readonly sources: readonly {
    readonly sessions: number;
    readonly source: string;
  }[];
}

/**
 * Computes last month's MRR and the top traffic sources, as the agent should answer them.
 *
 * @param client - Any connection that can read the schema.
 * @param schema - Validated schema name.
 * @param timezone - Reporting time zone.
 * @returns The answers to the example questions.
 */
export const summarizeDemoData = async (
  client: ClientBase,
  schema: string,
  timezone: string
): Promise<DemoSummary> => {
  await client.query("SELECT set_config('TimeZone', $1, false)", [timezone]);
  const mrr = await client.query(mrrLastMonthSql(schema));
  const sources = await client.query(topSourcesLast10DaysSql(schema));
  const [month] = z
    .array(z.object({ month_start: z.string(), mrr: z.string() }))
    .parse(mrr.rows);
  return {
    monthStart: month?.month_start ?? "",
    mrr: month?.mrr ?? "0",
    sources: z
      .array(z.object({ sessions: z.number(), source: z.string() }))
      .parse(sources.rows),
  };
};
