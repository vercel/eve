import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { allowedRelations } from "./models.ts";
import { QueryError, validateSqlAst } from "./sql-policy.ts";

const MAX_ROWS = 200;
const MAX_COLUMNS = 32;
const MAX_BYTES = 64 * 1024;
const MAX_SQL_BYTES = 16 * 1024;
const QUERY_TIMEOUT_MS = 15_000;
const MAX_ACTIVE_QUERIES = 4;
const INTERRUPTED_MESSAGE =
  "Query interrupted or timed out. Narrow the date range or simplify the query.";
let activeQueries = 0;

export async function querySql(sql: string, signal?: AbortSignal) {
  if (!sql.trim() || Buffer.byteLength(sql) > MAX_SQL_BYTES)
    throw new QueryError("Supply SQL between 1 and 16,384 bytes.");
  signal?.throwIfAborted();
  if (activeQueries >= MAX_ACTIVE_QUERIES)
    throw new QueryError("Too many active queries. Try again after the current queries finish.");
  activeQueries++;
  const started = Date.now();
  let connection: DuckDBConnection | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    connection?.interrupt();
  };
  try {
    const path = process.env.DUCKDB_CONNECTION || "./data/jaffle_shop.duckdb";
    const remote = path.startsWith("md:");
    const options: Record<string, string> = {
      threads: "2",
      memory_limit: "256MB",
      max_temp_directory_size: "0B",
    };
    if (remote) {
      const token = process.env.motherduck_token;
      if (!token)
        throw new QueryError(
          "MotherDuck is not configured. Ask the operator to set motherduck_token.",
        );
      options.motherduck_token = token;
      options.connection_timeout = "10s";
    } else {
      options.access_mode = "READ_ONLY";
      options.enable_external_access = "false";
    }
    const instance = await DuckDBInstance.fromCache(path, options);
    connection = await instance.connect();
    signal?.throwIfAborted();
    signal?.addEventListener("abort", interrupt, { once: true });
    timer = setTimeout(interrupt, QUERY_TIMEOUT_MS);
    // The serializer requires a literal at bind time, rather than a parameter.
    const literal = `'${sql.replaceAll("'", "''")}'`;
    const parsed = await connection.runAndReadAll(`SELECT json_serialize_sql(${literal})`);
    validateSqlAst(JSON.parse(String(parsed.getRowsJS()[0][0])), allowedRelations);
    const query = sql.trim().replace(/;$/u, "");
    // One extra row reveals truncation without counting the full result.
    const reader = await connection.streamAndRead(
      `SELECT * FROM (\n${query}\n) AS company_brain_result LIMIT ${MAX_ROWS + 1}`,
    );
    if (reader.columnCount > MAX_COLUMNS) throw new QueryError("Select at most 32 columns.");
    const columns = reader
      .columnNames()
      .map((name, index) => ({ name, type: reader.columnType(index).toString() }));
    await reader.readUntil(MAX_ROWS + 1);
    const rows = [];
    let bytes = Buffer.byteLength(JSON.stringify(columns));
    if (bytes > MAX_BYTES) throw new QueryError("Shorten the output column names.");
    let truncated = reader.currentRowCount > MAX_ROWS;
    for (const row of reader.getRowsJson().slice(0, MAX_ROWS)) {
      bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes > MAX_BYTES) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
    if (interrupted) throw new QueryError(INTERRUPTED_MESSAGE);
    return { sql, columns, rows, truncated, maxRows: MAX_ROWS, durationMs: Date.now() - started };
  } catch (error) {
    if (error instanceof QueryError) throw error;
    if (interrupted || signal?.aborted) throw new QueryError(INTERRUPTED_MESSAGE);
    throw new QueryError(
      "Query failed. Check get_model for column names and types, SQL syntax, and whether the operator has run pnpm data:build and configured database access.",
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", interrupt);
    activeQueries--;
    connection?.closeSync();
  }
}
