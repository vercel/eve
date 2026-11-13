import { randomBytes, randomUUID } from "node:crypto";
import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  type ConnectionPrincipal,
} from "eve/connections";
import { z } from "zod";
import { hash, linkConfig, LinkSetupError, seal, unseal, type LinkConfig } from "./config";
import { createLinkStore, ownerKey, type Grant, type LinkOwner, type LinkStore, type OwnerStore } from "./store";

const scopes = ["payment_methods.agentic", "userinfo:read"];
const tokenResponse = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().int().positive().max(365 * 24 * 60 * 60),
  scope: z.string(),
});
interface Tokens { accessToken: string; refreshToken: string; expiresAt: number; scopes: string[] }
interface Secrets { state: string; verifier: string; callbackUrl: string }
interface Callback { state: string; code?: string; error?: string }
export type LinkResume = { attemptId: string };

function failed(reason: string): never {
  throw new ConnectionAuthorizationFailedError("link", { reason, retryable: false });
}

export function linkOwner(principal: ConnectionPrincipal): LinkOwner {
  if (principal.type !== "user" || principal.issuer !== "linq"
    || !principal.id.startsWith("linq:") || principal.id.length <= 5 || principal.id.length > 512)
    return failed("principal_required");
  return { issuer: principal.issuer, id: principal.id };
}

function parseCallback(params: Readonly<Record<string, string>>): Callback {
  const { state, code, error } = params;
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || Boolean(code) === Boolean(error)
    || (code !== undefined && (code.length === 0 || code.length > 4096))
    || (error !== undefined && !/^[a-zA-Z0-9_]{1,100}$/.test(error)))
    return failed("invalid_callback");
  return { state, ...(code ? { code } : { error }) };
}

export class LinkOAuth {
  constructor(
    readonly config: LinkConfig,
    readonly store: LinkStore,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private tokenContext(owner: LinkOwner): string { return `link:tokens:${ownerKey(owner)}`; }
  private attemptContext(owner: LinkOwner, id: string): string { return `link:attempt:${ownerKey(owner)}:${id}`; }
  private tokens(owner: LinkOwner, grant: Grant): Tokens {
    if (!grant.encrypted_tokens) return failed("connection_missing");
    return unseal<Tokens>(grant.encrypted_tokens, this.config.encryptionKey, this.tokenContext(owner));
  }
  private encryptedTokens(owner: LinkOwner, tokens: Tokens): string {
    return seal(tokens, this.config.encryptionKey, this.tokenContext(owner));
  }
  private callbackUrl(value: string): URL {
    const target = new URL(value);
    if (!["https:", "http:"].includes(target.protocol) || target.username || target.password || target.hash
      || !/^\/eve\/v1\/connections\/[^/]+\/callback\/[^/]+\/[^/]+$/.test(target.pathname)) return failed("invalid_callback_origin");
    // This value comes only from Eve's server-side auth lifecycle, never an HTTP
    // return URL. withEve uses an internal dev port, and Vercel may use its project
    // domain. Forward the capability through Bell's configured public router while
    // retaining the exact original callback hash for completeAuthorization.
    return new URL(target.pathname + target.search, this.config.origin);
  }
  private async post(path: "token" | "revoke", fields: Record<string, string>): Promise<Response> {
    // No retries: codes and rotating refresh tokens may have been consumed even if
    // the response is lost. Never expose upstream bodies or credentials in errors.
    try {
      return await this.fetcher(`https://login.link.com/auth/${path}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${this.config.publishableKey}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, ...fields }),
      });
    } catch { return failed("link_request_failed"); }
  }
  private async exchange(fields: Record<string, string>): Promise<Tokens> {
    const response = await this.post("token", fields);
    if (!response.ok) return failed("token_exchange_failed");
    const parsed = tokenResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return failed("invalid_token_response");
    return {
      accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token,
      expiresAt: this.now() + parsed.data.expires_in * 1000,
      scopes: parsed.data.scope.split(/[ ,]+/).filter(Boolean),
    };
  }
  private tokenResult(tokens: Tokens) {
    if (!scopes.every((scope) => tokens.scopes.includes(scope))) return failed("missing_scopes");
    return { token: tokens.accessToken, expiresAt: tokens.expiresAt };
  }

  async getToken(principal: ConnectionPrincipal) {
    const owner = linkOwner(principal);
    return this.store.withOwner(owner, async (db) => {
      const grant = await db.grant();
      if (grant.status === "disconnecting") return failed("disconnect_pending");
      if (grant.status !== "active") throw new ConnectionAuthorizationRequiredError("link");
      let tokens = this.tokens(owner, grant);
      if (!scopes.every((scope) => tokens.scopes.includes(scope))) throw new ConnectionAuthorizationRequiredError("link");
      if (tokens.expiresAt <= this.now() + 60_000) {
        // Commit before the remote call. A crash leaves the grant blocked, never
        // apparently active with a refresh token that may already have rotated.
        await db.saveGrant({ ...grant, status: "reconnect" });
        tokens = await this.exchange({ grant_type: "refresh_token", refresh_token: tokens.refreshToken });
        await db.saveGrant({ ...grant, status: scopes.every((scope) => tokens.scopes.includes(scope)) ? "active" : "reconnect", encrypted_tokens: this.encryptedTokens(owner, tokens) });
      }
      return this.tokenResult(tokens);
    });
  }

  async evict(principal: ConnectionPrincipal): Promise<void> {
    const owner = linkOwner(principal);
    await this.store.withOwner(owner, async (db) => {
      const grant = await db.grant();
      if (grant.status === "active") await db.saveGrant({ ...grant, status: "reconnect" });
    });
  }

  async start(principal: ConnectionPrincipal, callbackUrl: string) {
    const owner = linkOwner(principal);
    this.callbackUrl(callbackUrl);
    return this.store.withOwner(owner, async (db) => {
      let grant = await db.grant();
      if (grant.status === "disconnecting") return failed("disconnect_pending");
      let attempt = await db.attemptForCallback(hash(callbackUrl));
      if (attempt) {
        if (attempt.generation !== grant.generation || attempt.status !== "pending"
          || attempt.expires_at.getTime() <= this.now()) return failed("authorization_expired");
      } else {
        // Revoke before requesting a replacement: revoking an old token after a
        // new consent could also revoke the new grant for the same Link account.
        // Failure preserves the old token for disconnect retry and blocks reuse.
        if (grant.encrypted_tokens) grant = await this.revokeGrant(db, owner, grant);
        const generation = grant.generation + 1;
        await db.saveGrant({ ...grant, generation, status: "reconnect" });
        await db.clearAttempts();
        const id = randomUUID();
        const secrets: Secrets = { state: randomBytes(32).toString("base64url"), verifier: randomBytes(32).toString("base64url"), callbackUrl };
        attempt = {
          id, issuer: owner.issuer, principal_id: owner.id, generation,
          state_hash: hash(secrets.state), callback_hash: hash(callbackUrl), result_hash: null,
          encrypted_secrets: seal(secrets, this.config.encryptionKey, this.attemptContext(owner, id)),
          status: "pending", expires_at: new Date(this.now() + 10 * 60_000),
        };
        await db.saveAttempt(attempt);
      }
      const secrets = unseal<Secrets>(attempt.encrypted_secrets!, this.config.encryptionKey, this.attemptContext(owner, attempt.id));
      const url = new URL("https://login.link.com/auth");
      url.search = new URLSearchParams({
        key: this.config.publishableKey, client_id: this.config.clientId, redirect_uri: this.config.redirectUri,
        response_type: "code", scope: scopes.join(" "), state: secrets.state,
        code_challenge: hash(secrets.verifier), code_challenge_method: "S256",
      }).toString();
      return {
        challenge: { displayName: "Link", url: url.href, expiresAt: attempt.expires_at.toISOString(), instructions: "Connect your wallet, then return to this text conversation. Keep this link private." },
        resume: { attemptId: attempt.id },
      };
    });
  }

  async forward(params: Readonly<Record<string, string>>): Promise<string> {
    const callback = parseCallback(params);
    const found = await this.store.findAttempt(hash(callback.state));
    if (!found) return failed("invalid_state");
    const owner = { issuer: found.issuer, id: found.principal_id };
    return this.store.withOwner(owner, async (db) => {
      const attempt = await db.attempt(found.id);
      const grant = await db.grant();
      const resultHash = hash(JSON.stringify(callback));
      if (!attempt || attempt.generation !== grant.generation
        || !(attempt.status === "pending" || (attempt.status === "forwarded" && attempt.result_hash === resultHash))
        || attempt.expires_at.getTime() <= this.now() || !attempt.encrypted_secrets)
        return failed("authorization_expired");
      const secrets = unseal<Secrets>(attempt.encrypted_secrets, this.config.encryptionKey, this.attemptContext(owner, attempt.id));
      const target = this.callbackUrl(secrets.callbackUrl);
      for (const [key, value] of Object.entries(callback)) target.searchParams.set(key, value);
      await db.saveAttempt({ ...attempt, status: "forwarded", result_hash: resultHash });
      return target.href;
    });
  }

  async complete(principal: ConnectionPrincipal, callbackUrl: string, resume: LinkResume | undefined, params: Readonly<Record<string, string>>) {
    const owner = linkOwner(principal);
    const callback = parseCallback(params);
    if (!resume || !z.uuid().safeParse(resume.attemptId).success) return failed("invalid_state");
    return this.store.withOwner(owner, async (db) => {
      const attempt = await db.attempt(resume.attemptId);
      const grant = await db.grant();
      if (!attempt || attempt.generation !== grant.generation || attempt.state_hash !== hash(callback.state)
        || attempt.callback_hash !== hash(callbackUrl) || attempt.result_hash !== hash(JSON.stringify(callback)))
        return failed("invalid_state");
      // Durable step replay after successful persistence must not exchange again.
      if (attempt.status === "completed" && grant.status === "active") {
        const tokens = this.tokens(owner, grant);
        if (tokens.expiresAt <= this.now()) return failed("authorization_expired");
        return this.tokenResult(tokens);
      }
      if (attempt.status !== "forwarded" || attempt.expires_at.getTime() <= this.now() || !attempt.encrypted_secrets)
        return failed("authorization_expired");
      if (callback.error) {
        await db.saveAttempt({ ...attempt, status: "failed", encrypted_secrets: null });
        return failed(callback.error === "access_denied" ? "access_denied" : "authorization_failed");
      }
      const secrets = unseal<Secrets>(attempt.encrypted_secrets, this.config.encryptionKey, this.attemptContext(owner, attempt.id));
      await db.saveAttempt({ ...attempt, status: "exchanging" });
      let tokens: Tokens;
      try {
        tokens = await this.exchange({
          grant_type: "authorization_code", redirect_uri: this.config.redirectUri,
          code: callback.code!, code_verifier: secrets.verifier,
        });
      } catch (error) {
        await db.saveAttempt({ ...attempt, status: "failed", encrypted_secrets: null });
        throw error;
      }
      const authorized = scopes.every((scope) => tokens.scopes.includes(scope));
      await db.saveAuthorization(
        { ...grant, status: authorized ? "active" : "reconnect", encrypted_tokens: this.encryptedTokens(owner, tokens) },
        { ...attempt, status: authorized ? "completed" : "failed", encrypted_secrets: null },
      );
      return this.tokenResult(tokens);
    });
  }

  async disconnect(principal: ConnectionPrincipal): Promise<{ status: "disconnected" }> {
    const owner = linkOwner(principal);
    return this.store.withOwner(owner, async (db) => {
      await this.revokeGrant(db, owner, await db.grant());
      return { status: "disconnected" };
    });
  }

  private async revokeGrant(db: OwnerStore, owner: LinkOwner, grant: Grant): Promise<Grant> {
    const blocked: Grant = { ...grant, generation: grant.generation + 1, status: "disconnecting" };
    await db.saveGrant(blocked);
    await db.clearAttempts();
    if (grant.encrypted_tokens) {
      const tokens = this.tokens(owner, grant);
      const response = await this.post("revoke", { token: tokens.refreshToken, token_type_hint: "refresh_token" });
      if (!response.ok) return failed("revocation_failed");
    }
    const disconnected: Grant = { ...blocked, status: "disconnected", encrypted_tokens: null };
    await db.saveGrant(disconnected);
    return disconnected;
  }
}

let service: LinkOAuth | undefined;
export function getLinkOAuth(): LinkOAuth {
  if (!service) {
    const config = linkConfig();
    service = new LinkOAuth(config, createLinkStore(config.databaseUrl));
  }
  return service;
}

export async function safeLinkCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof Error && ["ConnectionAuthorizationRequiredError", "ConnectionAuthorizationFailedError"].includes(error.name)) throw error;
    // Database, URL, and transport errors must not disclose connection strings or tokens.
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const reason = error instanceof LinkSetupError ? error.reason
      : code === "42P01" || code === "42703" ? "database_migration_required"
        : ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "28P01", "28000", "53300", "57P01", "57P02", "57P03", "08001", "08006"].includes(String(code))
          ? "database_unavailable" : "unexpected_error";
    console.error(JSON.stringify({ event: "link.error", reason,
      ...(error instanceof LinkSetupError && error.setting ? { setting: error.setting } : {}),
    }));
    throw new ConnectionAuthorizationFailedError("link", {
      reason: "link_unavailable", retryable: false,
      message: "Link is unavailable. Ask the operator to check the server's link.error diagnostic and Link setup guide.",
    });
  }
}
