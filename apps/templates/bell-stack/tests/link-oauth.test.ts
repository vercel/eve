import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "eve/tools";
import { hash, type LinkConfig } from "../server/link/config";
import { LinkOAuth } from "../server/link/oauth";
import { LinkStore, OwnerStore } from "../server/link/store";
import { linkCallback } from "../server/link/callback";
import { createLinkAuth, freshLinkContext } from "../agent/lib/link-auth";
import { ContextContainer, contextStorage } from "../node_modules/eve/dist/src/context/container.js";
import { AuthKey, SessionIdKey, SessionKey } from "../node_modules/eve/dist/src/context/keys.js";
import { CallbackBaseUrlKey, PendingAuthorizationResultKey, isAuthorizationSignal } from "../node_modules/eve/dist/src/harness/authorization.js";
import { createAuthorizationExecution } from "../node_modules/eve/dist/src/runtime/connections/scoped-authorization.js";
import { resolveWorkflowCallbackBaseUrl } from "../node_modules/eve/dist/src/execution/workflow-callback-url.js";
import type { ChannelAdapter } from "../node_modules/eve/dist/src/channel/adapter.js";
import linq from "../agent/channels/linq";

const databaseUrl = process.env.TEST_LINK_DATABASE_URL;

// Each run gets its own schema. This suite never reads application credentials or calls Link.
describe.skipIf(!databaseUrl)("Link OAuth with PostgreSQL", () => {
  const schema = `link_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  let store: LinkStore;
  let service: LinkOAuth;
  let config: LinkConfig;
  let now: number;
  let principal: { type: "user"; issuer: string; id: string };
  let callbackUrl: string;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  const tokens = (suffix = "first", scope = "payment_methods.agentic userinfo:read") => ({
    access_token: `access-${suffix}`, refresh_token: `refresh-${suffix}`,
    token_type: "Bearer", expires_in: 3600, scope,
  });

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 6 });
    await pool.query(await readFile(new URL("../migrations/001_link_oauth.sql", import.meta.url), "utf8"));
    store = new LinkStore(pool);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  beforeEach(() => {
    now = Date.now();
    principal = { type: "user", issuer: "linq", id: `linq:${randomUUID()}` };
    callbackUrl = `https://bell.example/eve/v1/connections/link/callback/${randomUUID()}/opaque-hook`;
    config = {
      databaseUrl: databaseUrl!, origin: "https://bell.example", redirectUri: "https://bell.example/api/link/oauth/callback",
      clientId: "client-id", clientSecret: "client-secret", publishableKey: "pk_test", encryptionKey: randomBytes(32),
    };
    fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(tokens()));
    service = new LinkOAuth(config, store, fetcher, () => now);
  });
  afterEach(() => vi.unstubAllEnvs());

  function eveContext() {
    const sessionId = `test-session-${randomUUID()}`;
    const auth = { principalType: "user" as const, principalId: principal.id, issuer: "linq", authenticator: "linq-message", attributes: {} };
    const context = new ContextContainer();
    context.set(AuthKey, auth);
    context.set(SessionIdKey, sessionId);
    context.set(SessionKey, { sessionId, auth: { current: auth } } as never);
    context.set(CallbackBaseUrlKey, resolveWorkflowCallbackBaseUrl(config.origin));
    return { context, auth, sessionId };
  }

  async function begin() {
    const start = await service.start(principal, callbackUrl);
    const url = new URL(start.challenge.url);
    return { start, url, state: url.searchParams.get("state")! };
  }
  async function authorize() {
    const { start, state } = await begin();
    const params = { state, code: "single-use-code" };
    await service.forward(params);
    const result = await service.complete(principal, callbackUrl, start.resume, params);
    return { start, params, result };
  }

  it("uses PKCE and the registered redirect, persists encrypted grants, and survives a restart", async () => {
    await expect(service.getToken(principal)).rejects.toMatchObject({ name: "ConnectionAuthorizationRequiredError" });
    const { start, url, state } = await begin();
    expect(url.origin).toBe("https://login.link.com");
    expect(url.searchParams.get("scope")).toBe("payment_methods.agentic userinfo:read");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(Object.keys(start.resume)).toEqual(["attemptId"]);
    expect(JSON.stringify(start)).not.toContain(config.clientSecret);
    expect(await service.start(principal, callbackUrl)).toEqual(start);
    const response = await linkCallback(new Request(`${config.redirectUri}?state=${state}&code=single-use-code`), () => service);
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const forwarded = new URL(response.headers.get("location")!);
    expect(forwarded.origin + forwarded.pathname).toBe(callbackUrl);
    const restarted = new LinkOAuth(config, new LinkStore(pool), fetcher, () => now);
    expect(await restarted.complete(principal, callbackUrl, start.resume, Object.fromEntries(forwarded.searchParams)))
      .toEqual({ token: "access-first", expiresAt: now + 3600_000 });
    const [, request] = fetcher.mock.calls[0];
    const form = request!.body as URLSearchParams;
    expect(hash(form.get("code_verifier")!)).toBe(url.searchParams.get("code_challenge"));
    expect(form.get("redirect_uri")).toBe(config.redirectUri);
    expect(form.get("client_secret")).toBe(config.clientSecret);
    expect(request!.redirect).toBe("error");
    expect(request!.headers).toMatchObject({ authorization: "Bearer pk_test" });
    expect(await restarted.getToken(principal)).toMatchObject({ token: "access-first" });
    const rows = await pool.query("SELECT encrypted_tokens FROM bell_link_grants WHERE principal_id = $1", [principal.id]);
    expect(JSON.stringify(rows.rows)).not.toMatch(/access-first|refresh-first|client-secret/);
    const attempt = await store.findAttempt(hash(state));
    expect(attempt?.encrypted_secrets).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("isolates senders and binds completion to the original principal, callback, and state", async () => {
    const { start, state } = await begin();
    const params = { state, code: "code" };
    await service.forward(params);
    const other = { ...principal, id: `linq:${randomUUID()}` };
    await expect(service.complete(other, callbackUrl, start.resume, params)).rejects.toMatchObject({ reason: "invalid_state" });
    await expect(service.complete(principal, callbackUrl + "other", start.resume, params)).rejects.toMatchObject({ reason: "invalid_state" });
    await expect(service.complete(principal, callbackUrl, start.resume, { ...params, code: "changed" })).rejects.toMatchObject({ reason: "invalid_state" });
    await expect(service.getToken(other)).rejects.toMatchObject({ name: "ConnectionAuthorizationRequiredError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed, unknown, duplicated, or expired callback state", async () => {
    const { state } = await begin();
    for (const query of ["state=invalid&code=code", `state=${randomBytes(32).toString("base64url")}&code=code`,
      `state=${state}&code=code&error=access_denied`, `state=${state}&code=a&code=b`, `state=${state}`]) {
      const response = await linkCallback(new Request(`${config.redirectUri}?${query}`), () => service);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(state);
    }
    now += 10 * 60_000;
    await expect(service.forward({ state, code: "code" })).rejects.toMatchObject({ reason: "authorization_expired" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports denial without exchanging or repeatedly retrying the same attempt", async () => {
    const { start, state } = await begin();
    const params = { state, error: "access_denied" };
    await service.forward(params);
    await expect(service.complete(principal, callbackUrl, start.resume, params)).rejects.toMatchObject({ reason: "access_denied", retryable: false });
    await expect(service.complete(principal, callbackUrl, start.resume, params)).rejects.toMatchObject({ reason: "authorization_expired" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects browser callback replay but permits durable completion replay without another exchange", async () => {
    const { start, params, result } = await authorize();
    await expect(service.forward(params)).rejects.toMatchObject({ reason: "authorization_expired" });
    expect(await service.complete(principal, callbackUrl, start.resume, params)).toEqual(result);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("can redeliver an identical callback after a lost redirect, but rejects changed results", async () => {
    const { start, state } = await begin();
    const params = { state, code: "code" };
    const target = await service.forward(params);
    const restarted = new LinkOAuth(config, new LinkStore(pool), fetcher, () => now);
    expect(await restarted.forward(params)).toBe(target);
    await expect(restarted.forward({ state, code: "different" })).rejects.toMatchObject({ reason: "authorization_expired" });
    await restarted.complete(principal, callbackUrl, start.resume, params);
    await expect(restarted.forward(params)).rejects.toMatchObject({ reason: "authorization_expired" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("never retries an authorization code after an uncertain exchange", async () => {
    const { start, state } = await begin();
    const params = { state, code: "code" };
    await service.forward(params);
    fetcher.mockRejectedValue(new Error("connection lost with secret data"));
    await expect(service.complete(principal, callbackUrl, start.resume, params)).rejects.toMatchObject({ reason: "link_request_failed" });
    await expect(service.complete(principal, callbackUrl, start.resume, params)).rejects.toMatchObject({ reason: "authorization_expired" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["bell_link_grants", "bell_link_oauth_attempts"])("keeps authorization blocked if the final %s write fails", async (table) => {
    const { start, state } = await begin();
    const params = { state, code: "single-use-code" };
    await service.forward(params);
    await pool.query(`CREATE FUNCTION reject_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status IN ('active', 'completed') THEN RAISE EXCEPTION 'completion write failed'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER reject_completion BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_completion();`);
    try {
      await expect(service.complete(principal, callbackUrl, start.resume, params)).rejects.toThrow("completion write failed");
    } finally {
      await pool.query(`DROP TRIGGER reject_completion ON ${table}; DROP FUNCTION reject_completion();`);
    }
    expect((await pool.query("SELECT status, encrypted_tokens FROM bell_link_grants WHERE principal_id = $1", [principal.id])).rows[0])
      .toEqual({ status: "reconnect", encrypted_tokens: null });
    expect(await store.findAttempt(hash(state))).toMatchObject({ status: "exchanging" });
    const restarted = new LinkOAuth(config, new LinkStore(pool), fetcher, () => now);
    await expect(restarted.complete(principal, callbackUrl, start.resume, params)).rejects.toMatchObject({ reason: "authorization_expired" });
    await expect(restarted.getToken(principal)).rejects.toMatchObject({ name: "ConnectionAuthorizationRequiredError" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("replays committed authorization after its persistence acknowledgment is lost", async () => {
    const { start, state } = await begin();
    const params = { state, code: "single-use-code" };
    await service.forward(params);
    const save = OwnerStore.prototype.saveAuthorization;
    vi.spyOn(OwnerStore.prototype, "saveAuthorization").mockImplementationOnce(async function (this: OwnerStore, grant, attempt) {
      await save.call(this, grant, attempt);
      throw new Error("persistence acknowledgment lost");
    });
    await expect(service.complete(principal, callbackUrl, start.resume, params)).rejects.toThrow("persistence acknowledgment lost");
    const restarted = new LinkOAuth(config, new LinkStore(pool), fetcher, () => now);
    await expect(restarted.complete(principal, callbackUrl, start.resume, params)).resolves.toMatchObject({ token: "access-first" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("requires new consent when the user grants only a subset of the scopes", async () => {
    fetcher.mockResolvedValue(Response.json(tokens("limited", "userinfo:read")));
    await expect(authorize()).rejects.toMatchObject({ reason: "missing_scopes", retryable: false });
    await expect(service.getToken(principal)).rejects.toMatchObject({ name: "ConnectionAuthorizationRequiredError" });
  });

  it("serializes concurrent refreshes across separate service instances and persists rotation", async () => {
    await authorize();
    now += 3550_000;
    fetcher.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return Response.json(tokens("rotated"));
    });
    const second = new LinkOAuth(config, new LinkStore(pool), fetcher, () => now);
    const results = await Promise.all([service.getToken(principal), second.getToken(principal), service.getToken(principal)]);
    expect(results.every((result) => result.token === "access-rotated")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const refresh = fetcher.mock.calls[1][1]!.body as URLSearchParams;
    expect(refresh.get("refresh_token")).toBe("refresh-first");
    now += 3550_000;
    await second.getToken(principal);
    expect((fetcher.mock.calls[2][1]!.body as URLSearchParams).get("refresh_token")).toBe("refresh-rotated");
  });

  it("blocks a possibly consumed refresh token after transport failure or process loss", async () => {
    await authorize();
    now += 3550_000;
    fetcher.mockRejectedValue(new Error("lost response"));
    await expect(service.getToken(principal)).rejects.toMatchObject({ reason: "link_request_failed" });
    await expect(service.getToken(principal)).rejects.toMatchObject({ name: "ConnectionAuthorizationRequiredError" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("evicts a rejected bearer so a subsequent tool call needs authorization", async () => {
    await authorize();
    await service.evict(principal);
    await expect(service.getToken(principal)).rejects.toMatchObject({ name: "ConnectionAuthorizationRequiredError" });
  });

  it("blocks use on failed revocation and permits retry", async () => {
    await authorize();
    fetcher.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(service.disconnect(principal)).rejects.toMatchObject({ reason: "revocation_failed" });
    await expect(service.getToken(principal)).rejects.toMatchObject({ reason: "disconnect_pending" });
    await expect(service.start(principal, callbackUrl)).rejects.toMatchObject({ reason: "disconnect_pending" });
    fetcher.mockResolvedValue(new Response(null, { status: 200 }));
    expect(await service.disconnect(principal)).toEqual({ status: "disconnected" });
    expect((fetcher.mock.calls.at(-1)![1]!.body as URLSearchParams).get("token")).toBe("refresh-first");
    expect((await pool.query("SELECT encrypted_tokens FROM bell_link_grants WHERE principal_id = $1", [principal.id])).rows[0].encrypted_tokens).toBeNull();
    await expect(service.getToken(principal)).rejects.toMatchObject({ name: "ConnectionAuthorizationRequiredError" });
  });

  it("invalidates pending callbacks on disconnect", async () => {
    const { start, state } = await begin();
    await service.forward({ state, code: "late-code" });
    await service.disconnect(principal);
    await expect(service.complete(principal, callbackUrl, start.resume, { state, code: "late-code" })).rejects.toMatchObject({ reason: "invalid_state" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("revokes the previous grant before requesting a replacement, then disconnects the new grant", async () => {
    await authorize();
    callbackUrl = callbackUrl.replace("opaque-hook", "replacement-hook");
    fetcher.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const { start, state } = await begin();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toBe("https://login.link.com/auth/revoke");
    expect((fetcher.mock.calls[1][1]!.body as URLSearchParams).get("token")).toBe("refresh-first");
    expect((await pool.query("SELECT encrypted_tokens FROM bell_link_grants WHERE principal_id = $1", [principal.id])).rows[0].encrypted_tokens).toBeNull();
    fetcher.mockResolvedValueOnce(Response.json(tokens("replacement")));
    await service.forward({ state, code: "replacement-code" });
    await service.complete(principal, callbackUrl, start.resume, { state, code: "replacement-code" });
    fetcher.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await service.disconnect(principal);
    expect((fetcher.mock.calls[3][1]!.body as URLSearchParams).get("token")).toBe("refresh-replacement");
  });

  it("retains a blocked previous grant if replacement revocation fails", async () => {
    await authorize();
    callbackUrl = callbackUrl.replace("opaque-hook", "replacement-hook");
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(begin()).rejects.toMatchObject({ reason: "revocation_failed" });
    await expect(service.getToken(principal)).rejects.toMatchObject({ reason: "disconnect_pending" });
    expect((await pool.query("SELECT encrypted_tokens FROM bell_link_grants WHERE principal_id = $1", [principal.id])).rows[0].encrypted_tokens).not.toBeNull();
  });

  it("supersedes old authorization attempts without allowing late wallet replacement", async () => {
    const old = await begin();
    await service.forward({ state: old.state, code: "old-code" });
    callbackUrl = callbackUrl.replace("opaque-hook", "new-hook");
    const current = await authorize();
    await expect(service.complete(principal, callbackUrl, old.start.resume, { state: old.state, code: "old-code" })).rejects.toMatchObject({ reason: "invalid_state" });
    expect(await service.getToken(principal)).toEqual(current.result);
  });

  it("rejects malformed framework callback capabilities", async () => {
    for (const destination of ["https://bell.example/other", "https://user:pass@bell.example/eve/v1/connections/link/callback/a/b", "file:///eve/v1/connections/link/callback/a/b"]) {
      await expect(service.start(principal, destination)).rejects.toMatchObject({ reason: "invalid_callback_origin" });
    }
  });

  it.each(["development", "production"])("resumes Eve authorization in the original Linq chat with a %s callback origin", async (environment) => {
    vi.stubEnv("VERCEL_ENV", environment);
    vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "bell-project.vercel.app");
    const { context, sessionId } = eveContext();
    const provider = createLinkAuth(() => service);
    const scoped = { scope: "link__retrieve_user_info", authorization: provider, connection: { url: "" } };
    const { adapter } = linq as unknown as { adapter: ChannelAdapter };
    const post = vi.fn(async () => ({ id: "consent-message" }));
    const editMessage = vi.fn();
    const channel = { thread: { id: "original-linq-chat", isDM: true, post, adapter: { editMessage }, startTyping: vi.fn() }, state: { pendingAuthMessageIds: {} } };
    await contextStorage.run(context, async () => {
      const execution = createAuthorizationExecution();
      const signal = await execution.run(() => execution.getToken(scoped));
      if (!isAuthorizationSignal(signal)) throw new Error("Expected Eve to suspend for consent.");
      const challenge = signal.challenges[0];
      expect(new URL(challenge.hookUrl).origin).toBe(environment === "production" ? "https://bell-project.vercel.app" : "http://127.0.0.1:54321");
      await adapter["authorization.required"]!({ name: challenge.name, authorization: challenge.challenge } as never, channel as never);
      expect(post).toHaveBeenCalledWith({ markdown: expect.stringContaining("https://login.link.com/auth?") });
      const state = new URL(challenge.challenge.url!).searchParams.get("state")!;
      const response = await linkCallback(new Request(`${config.redirectUri}?state=${state}&code=runtime-code`), () => service);
      expect(response.status).toBe(303);
      const redirected = new URL(response.headers.get("location")!);
      expect(redirected.origin).toBe(config.origin);
      expect(redirected.pathname).toBe(new URL(challenge.hookUrl).pathname);
      context.set(PendingAuthorizationResultKey, [{
        name: challenge.name, attemptId: challenge.attemptId, instanceId: challenge.instanceId,
        principal: challenge.principal, resume: challenge.resume, hookUrl: challenge.hookUrl,
        callback: { method: "GET", params: Object.fromEntries(redirected.searchParams) },
      }]);
      const resumed = createAuthorizationExecution();
      expect(await resumed.getToken(scoped)).toMatchObject({ token: "access-first" });
      expect(context.require(SessionIdKey)).toBe(sessionId);
      await adapter["authorization.completed"]!({ name: challenge.name, authorization: challenge.challenge, outcome: "authorized" } as never, channel as never);
      expect(editMessage).toHaveBeenCalledWith("original-linq-chat", "consent-message", { markdown: "Link connected." });
      expect(fetcher).toHaveBeenCalledOnce();
    });
  });

  it("checks a failed disconnect even when the current Eve step still caches the bearer", async () => {
    await authorize();
    const { context, auth, sessionId } = eveContext();
    const provider = createLinkAuth(() => service);
    const scoped = { scope: "link__retrieve_spend_request", authorization: provider, connection: { url: "" } };
    await contextStorage.run(context, async () => {
      const execution = createAuthorizationExecution();
      const ctx = {
        session: { id: sessionId, auth: { current: auth } },
        getToken: () => execution.getToken(scoped), requireAuth: () => execution.requireAuth(scoped),
      } as unknown as ToolContext;
      expect(await freshLinkContext(ctx).getToken(provider)).toMatchObject({ token: "access-first" });
      // Model another conversation disconnecting between requests in this step.
      fetcher.mockResolvedValue(new Response(null, { status: 503 }));
      await expect(service.disconnect(principal)).rejects.toMatchObject({ reason: "revocation_failed" });
      expect(await ctx.getToken(provider)).toMatchObject({ token: "access-first" });
      await expect(freshLinkContext(ctx).getToken(provider)).rejects.toMatchObject({ reason: "disconnect_pending" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  it("never repeats an exchange after a process loses its durable completion write", async () => {
    const { start, state } = await begin();
    const params = { state, code: "code" };
    await service.forward(params);
    // The durable state left by a process exiting after the marker commit.
    await pool.query("UPDATE bell_link_oauth_attempts SET status = 'exchanging' WHERE id = $1", [start.resume.attemptId]);
    const restarted = new LinkOAuth(config, new LinkStore(pool), fetcher, () => now);
    await expect(restarted.complete(principal, callbackUrl, start.resume, params)).rejects.toMatchObject({ reason: "authorization_expired" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
