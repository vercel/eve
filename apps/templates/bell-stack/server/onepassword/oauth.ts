import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { ConnectionAuthorizationRequiredError, type ConnectionPrincipal } from "eve/connections";
import { z } from "zod";
import { hash } from "../encrypted-record";
import { configuration, failed, frameworkCallback, integrationIdentity, ownerOf, scopes, type Config } from "./config";
import { OnePasswordStore, type ConnectionState, type OAuthAttempt, type RecordStore, type Tokens } from "./store";

const tokenResponse = z.object({
  access_token: z.string().min(1).max(16384), refresh_token: z.string().min(1).max(16384),
  token_type: z.string().refine(value => value.toLowerCase() === "bearer"),
  expires_in: z.number().int().positive().max(86400), scope: z.string().optional(),
  user_id: z.string().min(1).optional(), account_id: z.string().min(1).optional(),
});
export type Resume = { attemptId: string };
export class OnePasswordOAuth {
  constructor(readonly config: Config, readonly store: OnePasswordStore, private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now) {}
  private async exchange(fields: Record<string, string>): Promise<Tokens> {
    let response: Response;
    try {
      response = await this.fetcher("https://api.1password.com/v1/oauth/token", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(fields),
      });
    } catch { return failed("token_exchange_failed_reconnect"); }
    const parsed = tokenResponse.safeParse(await response.json().catch(() => null));
    if (!response.ok || !parsed.success) return failed("token_exchange_failed_reconnect");
    const value = parsed.data;
    if (value.scope && !scopes.split(" ").every(scope => value.scope!.split(" ").includes(scope))) return failed("missing_scopes");
    return { accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt: this.now() + value.expires_in * 1000, userId: value.user_id, accountId: value.account_id };
  }
  private marker(state: ConnectionState) { return { token: `onepassword-connected-${state.generation}` }; }
  private verifyIdentity(tokens: Tokens, identity: NonNullable<ConnectionState["identity"]>, requireUser = false): void {
    if ((requireUser && !tokens.userId) || (tokens.userId && tokens.userId !== identity.userId) || (tokens.accountId && tokens.accountId !== identity.accountId)) return failed("account_mismatch_disconnect_and_reconnect");
  }
  async status(principal: ConnectionPrincipal) {
    return this.store.withOwner(ownerOf(principal), async db => ({ status: (await db.read()).status }));
  }
  async getToken(principal: ConnectionPrincipal) {
    return this.store.withOwner(ownerOf(principal), async db => {
      const state = await db.read();
      await this.activeCredentials(db, state);
      return this.marker(state);
    });
  }
  async activeCredentials(db: RecordStore, state: ConnectionState) {
    if (state.status !== "active" || !state.tokens || !state.integrationKey || !state.identity) throw new ConnectionAuthorizationRequiredError("onepassword");
    await this.refresh(db, state);
    return { accessToken: state.tokens.accessToken, integrationKey: state.integrationKey };
  }
  async refresh(db: RecordStore, state: ConnectionState): Promise<void> {
    if (!state.tokens) return failed("connection_missing");
    if (state.tokens.expiresAt > this.now() + 60_000) return;
    const previousStatus = state.status;
    // Commit before calling a provider that rotates single-use refresh tokens.
    await db.write({ ...state, status: "refreshing" });
    const tokens = await this.exchange({ grant_type: "refresh_token", refresh_token: state.tokens.refreshToken, scope: scopes });
    if (state.identity) this.verifyIdentity(tokens, state.identity);
    state.tokens = tokens;
    state.status = previousStatus;
    await db.write(state);
  }
  async start(principal: ConnectionPrincipal, callbackUrl: string) {
    frameworkCallback(callbackUrl, this.config.origin);
    return this.store.withOwner(ownerOf(principal), async db => {
      const state = await db.read();
      if (state.status === "disconnecting") return failed("disconnect_pending");
      let attempt = state.attempt;
      if (!attempt || attempt.callbackUrl !== callbackUrl || attempt.expiresAt <= this.now() || attempt.status !== "pending") {
        attempt = { id: randomUUID(), state: randomBytes(32).toString("base64url"), verifier: randomBytes(32).toString("base64url"), callbackUrl, expiresAt: this.now() + 600_000, status: "pending" };
        state.attempt = attempt;
        state.login = undefined;
        state.status = "reconnect";

      }
      await db.saveTicket(state, hash(attempt.state), attempt.expiresAt);
      return { challenge: { displayName: "1Password", url: `${this.config.origin}/api/onepassword/start?state=${attempt.state}`, expiresAt: new Date(attempt.expiresAt).toISOString(), instructions: "Connect your personal 1Password account. Keep this link private, then return to this conversation." }, resume: { attemptId: attempt.id } };
    });
  }
  private async ticket<T>(state: string, operation: (db: RecordStore, record: ConnectionState, attempt: OAuthAttempt) => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return failed("invalid_state");
    const owner = await this.store.ticketOwner(hash(state));
    if (!owner) return failed("invalid_state");
    return this.store.withOwner(owner, async db => {
      const record = await db.read(), attempt = record.attempt;
      if (!attempt || attempt.state !== state || attempt.expiresAt <= this.now()) return failed("authorization_expired");
      return operation(db, record, attempt);
    });
  }
  async open(state: string, browserNonce: string) {
    return this.ticket(state, async (db, record, attempt) => {
      if (attempt.status !== "pending") return failed("authorization_expired");
      attempt.browserHash = hash(browserNonce);
      await db.write(record);
      const url = new URL("https://my.1password.com/oauth/authorize");
      url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: this.config.redirectUri, response_type: "code", scope: scopes, state, code_challenge: hash(attempt.verifier), code_challenge_method: "S256" }).toString();
      return url.href;
    });
  }
  async capture(input: { state: string; code?: string; error?: string; integrationKey?: string }, browserNonce: string) {
    return this.ticket(input.state, async (db, record, attempt) => {
      if (!browserNonce || attempt.browserHash !== hash(browserNonce)) return failed("browser_binding_mismatch");
      if ((attempt.status === "completed" || attempt.status === "failed") && attempt.result) return this.forward(attempt);
      if (attempt.status !== "pending") return failed("authorization_expired");
      if (input.error || !input.code || input.code.length > 4096) {
        attempt.status = "failed";
        attempt.verifier = "";
        attempt.result = randomBytes(32).toString("base64url");
        await db.write(record);
        return this.forward(attempt);
      }
      if (input.integrationKey) {
        const identity = integrationIdentity(input.integrationKey, this.config.clientId);
        if (record.identity && identity.path !== record.identity.path) return failed("disconnect_before_changing_account");
        attempt.integrationKey = input.integrationKey;
        record.integrationKey = input.integrationKey;
        record.identity = identity;
      }
      // Save the one-time fragment before exchanging the code. Failed exchanges retain it for recovery.
      attempt.status = "exchanging";
      await db.write(record);
      const tokens = await this.exchange({ grant_type: "authorization_code", code: input.code, code_verifier: attempt.verifier, redirect_uri: this.config.redirectUri });
      const integrationKey = attempt.integrationKey ?? record.integrationKey;
      if (!integrationKey) {
        record.tokens = tokens;
        record.status = "reconnect";
        attempt.status = "failed";
        await db.write(record);
        return failed("integration_key_missing_disconnect_and_reconnect");
      }
      const identity = integrationIdentity(integrationKey, this.config.clientId);
      this.verifyIdentity(tokens, identity, !attempt.integrationKey);
      record.tokens = tokens;
      record.integrationKey = integrationKey;
      record.identity = identity;
      record.generation++;
      record.status = "active";
      attempt.status = "completed";
      attempt.verifier = "";
      attempt.integrationKey = undefined;
      attempt.result = randomBytes(32).toString("base64url");
      await db.write(record);
      return this.forward(attempt);
    });
  }
  private forward(attempt: OAuthAttempt): string {
    const url = frameworkCallback(attempt.callbackUrl, this.config.origin);
    url.searchParams.set("result", attempt.result!);
    return url.href;
  }
  async complete(principal: ConnectionPrincipal, callbackUrl: string, resume: Resume | undefined, params: Readonly<Record<string, string>>) {
    return this.store.withOwner(ownerOf(principal), async db => {
      const record = await db.read(), attempt = record.attempt;
      if (!resume || !attempt || attempt.id !== resume.attemptId || attempt.callbackUrl !== callbackUrl || !params.result || params.result !== attempt.result) return failed("invalid_completion");
      if (attempt.status === "failed") return failed("authorization_denied");
      if (attempt.status !== "completed" || record.status !== "active") return failed("invalid_completion");
      return this.marker(record);
    });
  }
  async disconnect(principal: ConnectionPrincipal) {
    return this.store.withOwner(ownerOf(principal), async db => {
      const state = await db.read();
      if (!state.tokens && state.integrationKey) return failed("reconnect_before_disconnect");
      if (!state.tokens) { await db.write({ status: "disconnected", generation: state.generation + 1 }); return { status: "disconnected" }; }
      if (state.status === "refreshing") return failed("refresh_uncertain_reconnect_before_disconnect");
      state.status = "disconnecting";
      state.attempt = undefined;
      state.login = undefined;
      await db.write(state);
      await this.refresh(db, state);
      let response: Response;
      try {
        response = await this.fetcher("https://api.1password.com/v1alpha1/oauth-integrations/self:revoke", { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${state.tokens.accessToken}`, "Content-Type": "application/json" }, body: "{}" });
      } catch { return failed("disconnect_failed_retry"); }
      if (!response.ok) return failed("disconnect_failed_retry");
      await db.write({ status: "disconnected", generation: state.generation + 1 });
      return { status: "disconnected" };
    });
  }
}
let singleton: OnePasswordOAuth | undefined;
export function getOnePassword(): OnePasswordOAuth {
  if (!singleton) {
    const config = configuration();
    const pool = new Pool({ connectionString: config.databaseUrl, max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
    pool.on("error", () => console.error("1Password database connection failed."));
    singleton = new OnePasswordOAuth(config, new OnePasswordStore(pool, config.encryptionKey));
  }
  return singleton;
}
