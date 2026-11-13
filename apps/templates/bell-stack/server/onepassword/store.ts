import { Pool, type PoolClient } from "pg";
import { seal, unseal } from "../encrypted-record";
import { failed } from "./config";

export interface Tokens { accessToken: string; refreshToken: string; expiresAt: number; userId?: string; accountId?: string }
export interface OAuthAttempt {
  id: string; state: string; verifier: string; callbackUrl: string; expiresAt: number;
  status: "pending" | "exchanging" | "completed" | "failed";
  browserHash?: string; result?: string; integrationKey?: string;
}
export interface LoginRequest {
  id: string; sessionId: string; generation: number; loginUrl: string; successUrl: string;
  callbackUrl: string; cap: string; expiresAt: number; status: "creating" | "pending" | "approved" | "filled" | "failed";
  browserSessionId?: string; requestId?: string; entryId?: string; appLink?: string; reference?: string;
  openedAt?: number; nextCheckAt?: number; result?: string;
}
export interface ConnectionState {
  status: "disconnected" | "active" | "reconnect" | "refreshing" | "disconnecting";
  generation: number;
  tokens?: Tokens;
  integrationKey?: string;
  identity?: { path: string; accountId: string; userId: string };
  attempt?: OAuthAttempt;
  login?: LoginRequest;
}
export class RecordStore {
  constructor(private readonly client: PoolClient, readonly owner: string, private readonly key: Buffer) {}
  async read(): Promise<ConnectionState> {
    const result = await this.client.query<{ encrypted_state: string }>("SELECT encrypted_state FROM bell_onepassword_connections WHERE owner=$1", [this.owner]);
    if (!result.rows[0]) return { status: "disconnected", generation: 0 };
    try { return unseal<ConnectionState>(result.rows[0].encrypted_state, this.key, `onepassword:${this.owner}`); }
    catch { return failed("credentials_unreadable"); }
  }
  async write(state: ConnectionState): Promise<void> {
    await this.client.query("INSERT INTO bell_onepassword_connections(owner,encrypted_state) VALUES($1,$2) ON CONFLICT(owner) DO UPDATE SET encrypted_state=EXCLUDED.encrypted_state,updated_at=now()", [this.owner, seal(state, this.key, `onepassword:${this.owner}`)]);
  }
  async saveTicket(state: ConnectionState, hash: string, expiresAt: number): Promise<void> {
    await this.client.query("BEGIN");
    try {
      await this.write(state);
      await this.client.query("DELETE FROM bell_onepassword_tickets WHERE owner=$1 OR expires_at<now()", [this.owner]);
      await this.client.query("INSERT INTO bell_onepassword_tickets(hash,owner,expires_at) VALUES($1,$2,$3)", [hash, this.owner, new Date(expiresAt)]);
      await this.client.query("COMMIT");
    } catch (error) { await this.client.query("ROLLBACK"); throw error; }
  }
}
export class OnePasswordStore {
  constructor(readonly pool: Pool, private readonly key: Buffer) {}
  async ticketOwner(hash: string): Promise<string | undefined> {
    return (await this.pool.query<{ owner: string }>("SELECT owner FROM bell_onepassword_tickets WHERE hash=$1 AND expires_at>now()", [hash])).rows[0]?.owner;
  }
  async withOwner<T>(owner: string, operation: (db: RecordStore) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let destroy = false;
    try {
      await client.query("SET statement_timeout='30s'");
      // The session lock spans committed crash markers around single-use token exchanges.
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`onepassword:${owner}`]);
      return await operation(new RecordStore(client, owner, this.key));
    } finally {
      try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`onepassword:${owner}`]); }
      catch { destroy = true; }
      client.release(destroy);
    }
  }
}
