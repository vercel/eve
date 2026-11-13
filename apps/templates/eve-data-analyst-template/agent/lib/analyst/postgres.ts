import { Pool } from "pg";
import type { CustomTypesConfig, PoolClient } from "pg";
import { z } from "zod";

import {
  analystConfig,
  MAX_CELL_CHARS,
  MAX_OUTPUT_CHARS,
} from "#lib/analyst/config";
import {
  arrayRowsSchema,
  boundRows,
  columnTypeName,
  typeParsers,
} from "#lib/analyst/serialize";
import type { BoundedRows } from "#lib/analyst/serialize";
import {
  findForbiddenCall,
  findRelations,
  planSummary,
  wrapQuery,
} from "#lib/analyst/sql";
import type { PlanEstimate } from "#lib/analyst/sql";

/** One query as the analyst sends it to node-postgres. */
export interface AnalystQuery {
  /** "extended" forces the extended protocol, which rejects input containing more than one statement. */
  readonly queryMode?: "extended";
  readonly rowMode?: "array";
  readonly text: string;
  readonly types?: CustomTypesConfig;
  readonly values?: readonly (number | string | readonly string[])[];
}

/** The parts of a node-postgres result the analyst reads; rows are parsed before use. */
export interface AnalystQueryResult {
  readonly fields: readonly {
    readonly dataTypeID: number;
    readonly name: string;
  }[];
  readonly rows: readonly unknown[];
}

/** The node-postgres client operations the analyst uses. */
export interface AnalystClient {
  readonly query: (query: AnalystQuery) => Promise<AnalystQueryResult>;
  readonly release: (destroy: boolean) => void;
}

/**
 * Raised when Postgres can't be reached or can't switch to the caller's role, so rewriting the query won't help.
 *
 * @remarks Messages start with "The warehouse is unavailable" and never include the database host.
 */
export class WarehouseUnavailableError extends Error {
  /**
   * @param message - Model-visible explanation, without host details.
   * @param options - Standard error options, usually the underlying `cause`.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WarehouseUnavailableError";
  }
}

const sqlStateSchema = z.object({ code: z.string().regex(/^[0-9A-Z]{5}$/u) });

/* SQLSTATE classes for connection, authentication, missing database, resource, shutdown, and system errors. */
const UNAVAILABLE_SQLSTATE = /^(?:08|28|3D|53|57P0[1-3]|58)/u;

/** An error that means the warehouse is unavailable: the analyst's own, or a Postgres error carrying a SQLSTATE. */
export type UnavailableError =
  | WarehouseUnavailableError
  | { readonly code: string };

/**
 * Checks whether an error means the warehouse is unavailable rather than the query being wrong.
 *
 * @param error - Anything thrown while planning or running a query.
 * @returns True for {@link WarehouseUnavailableError} and Postgres errors whose SQLSTATE names a server or connection failure.
 * @remarks A dropped socket surfaces as a plain error without a SQLSTATE and returns false.
 */
export const isWarehouseUnavailable = (
  error: unknown
): error is UnavailableError => {
  if (error instanceof WarehouseUnavailableError) {
    return true;
  }
  const parsed = sqlStateSchema.safeParse(error);
  return parsed.success && UNAVAILABLE_SQLSTATE.test(parsed.data.code);
};

let pool: Pool | undefined;

const sharedPool = (): Pool => {
  if (!pool) {
    // Small pool: each serverless instance gets its own, and questions are bursty.
    pool = new Pool({
      application_name: "eve-data-analyst",
      connectionString: analystConfig().ANALYST_DATABASE_URL,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 10_000,
      max: 3,
    });
    // An idle client can lose its connection at any time; without a listener that error crashes the process.
    pool.on("error", (error) => {
      console.warn("analyst.postgres_idle_client_error", error.message);
    });
  }
  return pool;
};

/* @types/pg doesn't declare queryMode, so pass the query as a plain config object. */
const fromPoolClient = (client: PoolClient): AnalystClient => ({
  query: (query) => {
    const { values, ...rest } = query;
    const config = { ...rest, ...(values && { values: [...values] }) };
    return client.query(config);
  },
  release: (destroy) => client.release(destroy),
});

/** External Postgres access, swappable in tests. */
export const postgres = {
  connect: async (): Promise<AnalystClient> =>
    fromPoolClient(await sharedPool().connect()),
};

/* Opens the read-only transaction and applies every session setting. The caller rolls back. */
const beginReadOnly = async (
  client: AnalystClient,
  role: string
): Promise<void> => {
  const config = analystConfig();
  try {
    // One round trip: the simple protocol runs these trusted statements in order.
    await client.query({
      text: [
        "BEGIN TRANSACTION READ ONLY",
        `SET LOCAL statement_timeout = ${config.ANALYST_STATEMENT_TIMEOUT_MS}`,
        `SET LOCAL ROLE ${role}`,
        `SET LOCAL search_path = ${config.ANALYST_SCHEMAS.join(", ")}`,
        `SET LOCAL TIME ZONE '${config.ANALYST_TIMEZONE}'`,
      ].join(";\n"),
    });
  } catch (error) {
    // A role or grant missing from deploy-time setup fails here, and no query rewrite fixes it.
    const detail = error instanceof Error ? error.message : String(error);
    throw new WarehouseUnavailableError(
      `The warehouse is unavailable: couldn't start a read-only session as your database role (${detail}). An admin can run \`pnpm db:doctor\` to see why.`,
      { cause: error }
    );
  }
};

/**
 * Runs work in a read-only transaction as the caller's role, then always rolls back.
 *
 * @typeParam T - Value returned by the work.
 * @param role - Validated Postgres role whose grants and row-level security apply.
 * @param fn - Work to run with the prepared client.
 * @returns The work's result.
 * @throws {@link WarehouseUnavailableError} When it can't connect or the session setup, such as `SET LOCAL ROLE`, fails.
 * @remarks Every setting is `SET LOCAL`, so nothing outlives the transaction on a pooled connection. Interpolated values are validated identifiers, integers, or IANA time zone names.
 */
export const withReadOnly = async <T>(
  role: string,
  fn: (client: AnalystClient) => Promise<T>
): Promise<T> => {
  let client: AnalystClient;
  try {
    client = await postgres.connect();
  } catch (error) {
    // Connection errors can name the host; keep them out of model-visible output.
    console.warn(
      "analyst.postgres_connect_failed",
      error instanceof Error ? error.message : String(error)
    );
    throw new WarehouseUnavailableError(
      "The warehouse is unavailable: couldn't connect to the database. An admin can run `pnpm db:doctor` to see why, or check the setup lines in the latest deploy log.",
      { cause: error }
    );
  }
  let broken = false;
  try {
    await beginReadOnly(client, role);
    return await fn(client);
  } finally {
    await client.query({ text: "ROLLBACK" }).catch(() => {
      broken = true;
    });
    // Destroy a connection whose rollback failed instead of returning it to the pool.
    client.release(broken);
  }
};

/** Planner estimate for a wrapped query and any forbidden function it calls. */
export interface QueryPlan extends PlanEstimate {
  readonly forbidden: string | null;
  /** Tables and views the plan reads, as `schema.relation`. */
  readonly tables: string[];
}

const explainRowsSchema = z
  .array(z.object({ "QUERY PLAN": z.json() }))
  .min(1, "EXPLAIN returned no plan.");

const explainIn = async (
  client: AnalystClient,
  sql: string
): Promise<QueryPlan> => {
  const limit = analystConfig().ANALYST_MAX_ROWS + 1;
  const result = await client.query({
    queryMode: "extended",
    text: `EXPLAIN (VERBOSE, FORMAT JSON) ${wrapQuery(sql, limit)}`,
  });
  const [{ "QUERY PLAN": plan }] = explainRowsSchema.parse(result.rows);
  return {
    ...planSummary(plan),
    forbidden: findForbiddenCall(plan),
    tables: findRelations(plan),
  };
};

/**
 * Plans the exact wrapped query `runReadOnlySql` would run, without executing it.
 *
 * @param sql - Model-authored query.
 * @param role - The caller's Postgres role.
 * @returns Planner cost, estimated rows, and any forbidden function call.
 * @remarks EXPLAIN without ANALYZE never executes the query.
 */
export const explainQuery = (sql: string, role: string): Promise<QueryPlan> =>
  withReadOnly(role, (client) => explainIn(client, sql));

/** One result column and its Postgres type. */
interface ResultColumn {
  readonly name: string;
  readonly type: string;
}

/** A bounded query result for the model. */
export interface QueryResult extends BoundedRows {
  readonly columns: ResultColumn[];
  readonly durationMs: number;
  readonly rowCount: number;
  readonly timezone: string;
  /** Tables and views the query read, as `schema.relation`. */
  readonly tables: string[];
}

/**
 * Runs one read-only query as the caller's role.
 *
 * @param sql - Model-authored query.
 * @param role - The caller's Postgres role.
 * @returns Typed columns and bounded rows; dates and timestamps are text in the reporting time zone.
 * @throws {@link WarehouseUnavailableError} When it can't connect or can't start the session as `role`.
 * @throws {@link Error} When the plan calls a forbidden function, or Postgres rejects or times out the query.
 * @remarks Read-only is enforced in layers: the extended protocol rejects stacked statements, the subquery wrapper rejects anything that isn't a query, the transaction is READ ONLY, and the role holds only SELECT grants.
 */
export const runReadOnlySql = (
  sql: string,
  role: string
): Promise<QueryResult> =>
  withReadOnly(role, async (client) => {
    const config = analystConfig();
    const plan = await explainIn(client, sql);
    if (plan.forbidden) {
      throw new Error(`Queries can't call ${plan.forbidden}().`);
    }
    const started = Date.now();
    const result = await client.query({
      queryMode: "extended",
      rowMode: "array",
      text: wrapQuery(sql, config.ANALYST_MAX_ROWS + 1),
      types: typeParsers,
    });
    const bounded = boundRows(arrayRowsSchema.parse(result.rows), {
      maxCellChars: MAX_CELL_CHARS,
      maxOutputChars: MAX_OUTPUT_CHARS,
      maxRows: config.ANALYST_MAX_ROWS,
    });
    return {
      columns: result.fields.map((field) => ({
        name: field.name,
        type: columnTypeName(field.dataTypeID),
      })),
      durationMs: Date.now() - started,
      rowCount: bounded.rows.length,
      tables: plan.tables,
      timezone: config.ANALYST_TIMEZONE,
      ...bounded,
    };
  });

/** Largest number of relations listed in a schema overview. */
const MAX_LISTED_TABLES = 300;

const tableSummaryRowsSchema = z.array(
  z.object({
    approx_rows: z.coerce.number().nullable(),
    comment: z.string().nullable(),
    kind: z.string(),
    name: z.string(),
  })
);

/** A queryable relation in the schema overview. */
export interface TableSummary {
  readonly approxRows: number | null;
  readonly comment: string | null;
  readonly kind: string;
  readonly name: string;
}

/**
 * Lists the tables and views the caller's role can read in the allowed schemas.
 *
 * @param role - The caller's Postgres role.
 * @returns Up to 300 relations with kind, planner row estimate, and comment.
 * @remarks A relation is listed only when the role has `USAGE` on its schema and `SELECT` on it, so each person sees just the tables their role can query, including tables in restricted schemas granted to their team.
 */
export const listTables = (
  role: string
): Promise<{ tables: TableSummary[]; truncated: boolean }> =>
  withReadOnly(role, async (client) => {
    const result = await client.query({
      text: `
        SELECT n.nspname || '.' || c.relname AS name,
               CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END AS kind,
               CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS approx_rows,
               obj_description(c.oid, 'pg_class') AS comment
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1)
          AND c.relkind IN ('r', 'p', 'v', 'm')
          AND NOT c.relispartition
          AND has_schema_privilege(n.oid, 'USAGE')
          AND has_table_privilege(c.oid, 'SELECT')
        ORDER BY n.nspname, c.relname
        LIMIT $2`,
      values: [analystConfig().ANALYST_SCHEMAS, MAX_LISTED_TABLES + 1],
    });
    const rows = tableSummaryRowsSchema.parse(result.rows);
    return {
      tables: rows.slice(0, MAX_LISTED_TABLES).map((row) => ({
        approxRows: row.approx_rows,
        comment: row.comment,
        kind: row.kind,
        name: row.name,
      })),
      truncated: rows.length > MAX_LISTED_TABLES,
    };
  });

const columnRowsSchema = z.array(
  z.object({
    column_comment: z.string().nullable(),
    column_name: z.string(),
    column_type: z.string(),
    name: z.string(),
    not_null: z.boolean(),
    table_comment: z.string().nullable(),
  })
);

const keyRowsSchema = z.array(
  z.object({ definition: z.string(), name: z.string() })
);

/** Columns, comments, and keys for one relation. */
export interface TableDetail {
  readonly columns: string[];
  readonly comment: string | null;
  readonly keys: string[];
  readonly name: string;
}

/**
 * Expands bare or schema-qualified table names into qualified names within the allowed schemas.
 *
 * @param names - Requested names, such as `customers` or `analytics.customers`.
 * @param schemas - Allowed schemas.
 * @returns Lowercase qualified candidates; names outside the allowed schemas are dropped.
 */
export const qualifyTableNames = (
  names: readonly string[],
  schemas: readonly string[]
): string[] => {
  const candidates = new Set<string>();
  for (const raw of names) {
    const name = raw.trim().toLowerCase().replaceAll('"', "");
    const [first = "", second] = name.split(".");
    if (second === undefined) {
      for (const schema of schemas) {
        candidates.add(`${schema}.${first}`);
      }
    } else if (schemas.includes(first)) {
      candidates.add(name);
    }
  }
  return [...candidates];
};

const describeColumn = (row: z.infer<typeof columnRowsSchema>[number]) =>
  `${row.column_name} ${row.column_type}${row.not_null ? " not null" : ""}${
    row.column_comment ? ` -- ${row.column_comment}` : ""
  }`;

/**
 * Describes specific tables the caller's role can read.
 *
 * @param role - The caller's Postgres role.
 * @param names - Bare or schema-qualified table names.
 * @returns Each visible table's columns (with type, nullability, and comment), comment, primary key, and foreign keys.
 */
export const describeTables = (
  role: string,
  names: readonly string[]
): Promise<TableDetail[]> =>
  withReadOnly(role, async (client) => {
    const qualified = qualifyTableNames(names, analystConfig().ANALYST_SCHEMAS);
    if (qualified.length === 0) {
      return [];
    }
    const columnResult = await client.query({
      text: `
            SELECT n.nspname || '.' || c.relname AS name,
                   obj_description(c.oid, 'pg_class') AS table_comment,
                   a.attname AS column_name,
                   format_type(a.atttypid, a.atttypmod) AS column_type,
                   a.attnotnull AS not_null,
                   col_description(c.oid, a.attnum) AS column_comment
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            WHERE n.nspname || '.' || c.relname = ANY($1)
              AND c.relkind IN ('r', 'p', 'v', 'm')
              AND has_schema_privilege(n.oid, 'USAGE')
              AND has_table_privilege(c.oid, 'SELECT')
            ORDER BY n.nspname, c.relname, a.attnum`,
      values: [qualified],
    });
    const keyResult = await client.query({
      text: `
            SELECT n.nspname || '.' || c.relname AS name,
                   pg_get_constraintdef(con.oid) AS definition
            FROM pg_catalog.pg_constraint con
            JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE con.contype IN ('p', 'f')
              AND n.nspname || '.' || c.relname = ANY($1)
              AND has_schema_privilege(n.oid, 'USAGE')
              AND has_table_privilege(c.oid, 'SELECT')
            ORDER BY n.nspname, c.relname, con.contype DESC, con.conname`,
      values: [qualified],
    });
    const columns = columnRowsSchema.parse(columnResult.rows);
    const keys = keyRowsSchema.parse(keyResult.rows);
    const tables = new Map<string, TableDetail>();
    for (const row of columns) {
      const table = tables.get(row.name) ?? {
        columns: [],
        comment: row.table_comment,
        keys: [],
        name: row.name,
      };
      table.columns.push(describeColumn(row));
      tables.set(row.name, table);
    }
    for (const row of keys) {
      tables.get(row.name)?.keys.push(row.definition);
    }
    return [...tables.values()];
  });

/**
 * Closes the shared pool so a script can exit.
 *
 * @returns Resolves once every client has disconnected.
 */
export const closePool = async (): Promise<void> => {
  await pool?.end();
  pool = undefined;
};
