import type { Pool } from "pg";
import { createRequire } from "node:module";
import type { Storage } from "./storage.js";
import { getVercelOidcToken } from "@vercel/oidc";
import { namespace, type Config } from "./config.js";
import type { Active, Experiment, Lease, Observation } from "./types.js";

export interface Sql {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
interface ConnectionOptions {
  max: number;
  connectionTimeoutMillis: number;
  statement_timeout: number;
  idleTimeoutMillis: number;
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  ssl?: { rejectUnauthorized: true };
  sslnegotiation?: "direct";
  maxLifetimeSeconds?: number;
  password?: () => Promise<string>;
}
const pools = new Map<string, Promise<Pool>>();
const requirePg = createRequire(import.meta.url);
const clients = new Map<string, Sql>();
const initialized = new WeakMap<object, Promise<unknown>>();
/** Preserves existing experiment ledgers in the optional PostgreSQL backend. */
export class PostgresStore implements Storage {
  constructor(
    readonly sql: Sql,
    readonly scope: string,
    readonly retentionDays = 7,
    readonly ledgerDays = 90,
  ) {}
  async init() {
    let pending = initialized.get(this.sql);
    if (!pending) {
      pending = this.sql.query(`CREATE TABLE IF NOT EXISTS eve_evolution_records (
        namespace text NOT NULL, key text NOT NULL, value jsonb NOT NULL,
        expires_at timestamptz, lease_owner text, lease_until timestamptz,
        fence bigint NOT NULL DEFAULT 0, PRIMARY KEY(namespace,key))`);
      initialized.set(this.sql, pending);
      pending.catch(() => initialized.delete(this.sql));
    }
    await pending;
  }
  async hasRecord(key: string): Promise<boolean> {
    await this.init();
    const result = await this.sql.query(
      "SELECT key FROM eve_evolution_records WHERE namespace=$1 AND key=$2",
      [this.scope, key],
    );
    return result.rowCount === 1;
  }
  async get<T>(key: string): Promise<T | null> {
    await this.init();
    const { rows } = await this.sql.query(
      "SELECT value FROM eve_evolution_records WHERE namespace=$1 AND key=$2 AND (expires_at IS NULL OR expires_at>clock_timestamp())",
      [this.scope, key],
    );
    return rows[0]?.value ?? null;
  }
  async put(key: string, value: unknown, days = this.ledgerDays): Promise<void> {
    await this.init();
    await this.sql.query(
      `INSERT INTO eve_evolution_records(namespace,key,value,expires_at) VALUES($1,$2,$3,clock_timestamp()+$4*interval '1 day')
      ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at`,
      [this.scope, key, JSON.stringify(value), days],
    );
  }
  async observe(observation: Observation): Promise<void> {
    await this.init();
    await this.sql.query(
      `INSERT INTO eve_evolution_records(namespace,key,value,expires_at) VALUES($1,$2,$3,to_timestamp($5/1000.0)+$4*interval '1 day') ON CONFLICT DO NOTHING`,
      [
        this.scope,
        `observation:${observation.id}`,
        JSON.stringify(observation),
        this.retentionDays,
        observation.at,
      ],
    );
  }
  async list<T>(prefix: string, limit = 100): Promise<T[]> {
    await this.init();

    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    const { rows } = await this.sql.query(
      `SELECT value FROM eve_evolution_records WHERE namespace=$1 AND key LIKE $2 AND (expires_at IS NULL OR expires_at>clock_timestamp()) ORDER BY COALESCE((value->>'updatedAt')::double precision,(value->>'createdAt')::double precision,0) DESC,key LIMIT $3`,
      [this.scope, `${escaped}%`, limit],
    );
    return rows.map((row) => row.value as T);
  }
  async observations(
    from: number,
    to: number,
  ): Promise<{ values: Observation[]; complete: boolean }> {
    await this.init();
    const { rows } = await this.sql.query(
      `SELECT value FROM eve_evolution_records WHERE namespace=$1 AND key LIKE 'observation:%' AND expires_at>clock_timestamp() AND (value->>'at')::double precision >= $2 AND (value->>'at')::double precision < $3 ORDER BY (value->>'at')::double precision LIMIT 10001`,
      [this.scope, from, to],
    );
    return { values: rows.slice(0, 10000).map((r) => r.value), complete: rows.length <= 10000 };
  }
  async acquire(owner: string, leaseMs = 3_600_000): Promise<Active | null> {
    await this.init();
    const { rows } = await this.sql.query(
      `INSERT INTO eve_evolution_records(namespace,key,value,lease_owner,lease_until,fence)
      VALUES($1,'active','null'::jsonb,$2,clock_timestamp()+$3*interval '1 millisecond',1)
      ON CONFLICT(namespace,key) DO UPDATE SET lease_owner=$2,lease_until=clock_timestamp()+$3*interval '1 millisecond',fence=eve_evolution_records.fence+1
      WHERE eve_evolution_records.lease_until IS NULL OR eve_evolution_records.lease_until<=clock_timestamp()
      RETURNING value,fence,extract(epoch from lease_until)*1000 AS until`,
      [this.scope, owner, leaseMs],
    );
    if (!rows.length) return null;
    return {
      lease: { owner, fence: Number(rows[0].fence), until: Number(rows[0].until) },
      experiment: rows[0].value,
    };
  }
  async save(lease: Lease, experiment: Experiment | null): Promise<void> {
    await this.init();
    const { rowCount } = await this.sql.query(
      `WITH saved AS (
      UPDATE eve_evolution_records SET value=$4::jsonb WHERE namespace=$1 AND key='active' AND lease_owner=$2 AND fence=$3 AND lease_until>clock_timestamp() RETURNING value
    ) INSERT INTO eve_evolution_records(namespace,key,value,expires_at)
      SELECT $1,CASE WHEN value IS NULL OR value='null'::jsonb THEN 'last-idle' ELSE 'experiment:'||(value->>'id') END,value,clock_timestamp()+$5*interval '1 day' FROM saved
      ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at`,
      [this.scope, lease.owner, lease.fence, JSON.stringify(experiment), this.ledgerDays],
    );
    if (!rowCount)
      throw new Error(
        "Self-improvement lease expired or was superseded; reconcile before retrying",
      );
  }
  async renew(lease: Lease, leaseMs = 3_600_000): Promise<void> {
    const { rowCount } = await this.sql.query(
      `UPDATE eve_evolution_records SET lease_until=clock_timestamp()+$4*interval '1 millisecond' WHERE namespace=$1 AND key='active' AND lease_owner=$2 AND fence=$3 AND lease_until>clock_timestamp()`,
      [this.scope, lease.owner, lease.fence, leaseMs],
    );
    if (!rowCount) throw new Error("Self-improvement lease lost");
  }
  async bindSession(
    lease: Lease,
    field: "coordinatorSession" | "writerSession",
    session: string,
  ): Promise<Experiment> {
    const { rows } = await this.sql.query(
      `UPDATE eve_evolution_records SET value=jsonb_set(value,ARRAY[$4]::text[],to_jsonb($5::text),true)
      WHERE namespace=$1 AND key='active' AND lease_owner=$2 AND fence=$3 AND lease_until>clock_timestamp()
      AND (value->>$4 IS NULL OR value->>$4=$5) RETURNING value`,
      [this.scope, lease.owner, lease.fence, field, session],
    );
    if (!rows.length)
      throw new Error(
        "Another delegated session already owns this evolution stage, or the lease expired",
      );
    return rows[0].value;
  }
  async release(lease: Lease): Promise<void> {
    await this.sql.query(
      "UPDATE eve_evolution_records SET lease_owner=NULL,lease_until=NULL WHERE namespace=$1 AND key='active' AND lease_owner=$2 AND fence=$3",
      [this.scope, lease.owner, lease.fence],
    );
  }
  async active(): Promise<Active | null> {
    await this.init();
    const { rows } = await this.sql.query(
      "SELECT value,lease_owner,fence,extract(epoch from lease_until)*1000 AS until FROM eve_evolution_records WHERE namespace=$1 AND key='active'",
      [this.scope],
    );
    const row = rows[0];
    return row?.value
      ? {
          experiment: row.value,
          lease: { owner: row.lease_owner, fence: Number(row.fence), until: Number(row.until) },
        }
      : null;
  }
  async purge(): Promise<number> {
    await this.init();
    const result = await this.sql.query(
      "DELETE FROM eve_evolution_records WHERE namespace=$1 AND expires_at<=clock_timestamp()",
      [this.scope],
    );
    return result.rowCount ?? 0;
  }
}
export function databaseConnection(
  c: Config,
  env: NodeJS.ProcessEnv = process.env,
  token: typeof getVercelOidcToken = getVercelOidcToken,
): { key: string; options: ConnectionOptions } {
  const url =
    c.databaseUrl?.() ?? env.EVE_EVOLUTION_DATABASE_URL ?? env.POSTGRES_URL ?? env.DATABASE_URL;
  const limits = {
    max: 3,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    idleTimeoutMillis: 10000,
  };
  if (url) return { key: `url:${url}`, options: { ...limits, connectionString: url } };
  if (c.database !== "vercel-postgres")
    throw new Error(
      "Configure a private durable Postgres URL or database:vercel-postgres for self-improvement",
    );
  const host = env.PGHOST?.trim(),
    port = Number(env.PGPORT || 5432);
  if (!host)
    throw new Error(
      "Vercel Postgres requires the project's PGHOST setting; load its environment before connecting locally",
    );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Vercel Postgres PGPORT is invalid");
  const connection = {
    host,
    port,
    user: env.PGUSER || "postgres",
    database: env.PGDATABASE || "postgres",
  };
  return {
    key: JSON.stringify(["vercel-postgres", c.project.teamId, c.project.projectId, connection]),
    options: {
      ...limits,
      ...connection,
      ssl: { rejectUnauthorized: true },
      sslnegotiation: "direct",
      maxLifetimeSeconds: 1500,

      password: () => token({ project: c.project.projectId, team: c.project.teamId }),
    },
  };
}
export function postgresStore(c: Config): PostgresStore {
  const connection = databaseConnection(c);
  let sql = clients.get(connection.key);
  if (!sql) {
    sql = {
      async query(text, values) {
        let pending = pools.get(connection.key);
        if (!pending) {
          pending = Promise.resolve().then(() => {
            let driver: typeof import("pg");
            try {
              driver = requirePg("pg");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
              throw new Error(
                "Install pg@^8.23.1 in the host to use the optional self-improvement Postgres adapter",
              );
            }
            return new driver.Pool(connection.options);
          });
          pools.set(connection.key, pending);
          pending.catch(() => pools.delete(connection.key));
        }
        return (await pending).query(text, values);
      },
    };
    clients.set(connection.key, sql);
  }
  return new PostgresStore(sql, namespace(c), c.privacy.retentionDays, c.privacy.ledgerDays);
}
/** Closes lazily opened PostgreSQL pools after trusted local work finishes. */
export async function closeStores(): Promise<void> {
  await Promise.all([...pools.values()].map(async (pool) => (await pool).end()));
  pools.clear();
  clients.clear();
}
