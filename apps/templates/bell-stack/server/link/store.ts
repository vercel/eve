import { Pool, type PoolClient } from "pg";

export interface LinkOwner { issuer: string; id: string }
export interface Grant {
  generation: number;
  status: "active" | "reconnect" | "disconnecting" | "disconnected";
  encrypted_tokens: string | null;
}
export interface Attempt {
  id: string;
  issuer: string;
  principal_id: string;
  generation: number;
  state_hash: string;
  callback_hash: string;
  result_hash: string | null;
  encrypted_secrets: string | null;
  status: "pending" | "forwarded" | "exchanging" | "completed" | "failed";
  expires_at: Date;
}

export function ownerKey(owner: LinkOwner): string {
  return JSON.stringify([owner.issuer, owner.id]);
}

export class OwnerStore {
  constructor(private readonly client: PoolClient, readonly owner: LinkOwner) {}

  async grant(): Promise<Grant> {
    await this.client.query(
      "INSERT INTO bell_link_grants (issuer, principal_id, status) VALUES ($1, $2, 'disconnected') ON CONFLICT DO NOTHING",
      [this.owner.issuer, this.owner.id],
    );
    const result = await this.client.query<Grant>(
      "SELECT generation, status, encrypted_tokens FROM bell_link_grants WHERE issuer = $1 AND principal_id = $2",
      [this.owner.issuer, this.owner.id],
    );
    return result.rows[0];
  }

  async saveGrant(grant: Grant): Promise<void> {
    await this.client.query(
      "UPDATE bell_link_grants SET generation = $3, status = $4, encrypted_tokens = $5, updated_at = now() WHERE issuer = $1 AND principal_id = $2",
      [this.owner.issuer, this.owner.id, grant.generation, grant.status, grant.encrypted_tokens],
    );
  }

  async saveAuthorization(grant: Grant, attempt: Attempt): Promise<void> {
    await this.client.query("BEGIN");
    try {
      await this.saveGrant(grant);
      await this.saveAttempt(attempt);
      await this.client.query("COMMIT");
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  async attempt(id: string): Promise<Attempt | undefined> {
    return (await this.client.query<Attempt>(
      "SELECT * FROM bell_link_oauth_attempts WHERE id = $1 AND issuer = $2 AND principal_id = $3",
      [id, this.owner.issuer, this.owner.id],
    )).rows[0];
  }

  async attemptForCallback(callbackHash: string): Promise<Attempt | undefined> {
    return (await this.client.query<Attempt>(
      "SELECT * FROM bell_link_oauth_attempts WHERE callback_hash = $1 AND issuer = $2 AND principal_id = $3",
      [callbackHash, this.owner.issuer, this.owner.id],
    )).rows[0];
  }

  async saveAttempt(attempt: Attempt): Promise<void> {
    await this.client.query(
      `INSERT INTO bell_link_oauth_attempts
       (id, issuer, principal_id, generation, state_hash, callback_hash, result_hash, encrypted_secrets, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET result_hash = EXCLUDED.result_hash,
         encrypted_secrets = EXCLUDED.encrypted_secrets, status = EXCLUDED.status
       WHERE bell_link_oauth_attempts.issuer = EXCLUDED.issuer AND bell_link_oauth_attempts.principal_id = EXCLUDED.principal_id`,
      [attempt.id, this.owner.issuer, this.owner.id, attempt.generation, attempt.state_hash,
        attempt.callback_hash, attempt.result_hash, attempt.encrypted_secrets, attempt.status, attempt.expires_at],
    );
  }

  async clearAttempts(): Promise<void> {
    await this.client.query(
      "UPDATE bell_link_oauth_attempts SET status = 'failed', encrypted_secrets = NULL WHERE issuer = $1 AND principal_id = $2",
      [this.owner.issuer, this.owner.id],
    );
  }
}

export class LinkStore {
  constructor(readonly pool: Pool) {}

  async findAttempt(stateHash: string): Promise<Attempt | undefined> {
    return (await this.pool.query<Attempt>(
      "SELECT * FROM bell_link_oauth_attempts WHERE state_hash = $1", [stateHash],
    )).rows[0];
  }

  async withOwner<T>(owner: LinkOwner, operation: (store: OwnerStore) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let locked = false;
    let destroy = false;
    try {
      // A session lock spans independently committed writes around remote OAuth calls.
      // In-progress markers must survive process failure; a transaction rollback would
      // otherwise allow a single-use authorization code or refresh token to be retried.
      await client.query("SET statement_timeout = '30s'");
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [ownerKey(owner)]);
      locked = true;
      return await operation(new OwnerStore(client, owner));
    } finally {
      if (locked) {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [ownerKey(owner)]);
        } catch { destroy = true; }
      } else { destroy = true; }
      client.release(destroy);
    }
  }
}

export function createLinkStore(databaseUrl: string): LinkStore {
  const pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
  pool.on("error", () => console.error("Link database connection failed."));
  return new LinkStore(pool);
}
