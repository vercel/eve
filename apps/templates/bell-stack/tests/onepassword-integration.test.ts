import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { markSecretFill, withPersonalBrowserLock } from "../server/onepassword/browser-policy";
import { OnePasswordStore } from "../server/onepassword/store";
import { OnePasswordOAuth } from "../server/onepassword/oauth";
import { OnePasswordLogin, loginId } from "../server/onepassword/login";
import { ownerOf, scopes, type Config } from "../server/onepassword/config";
import { hash } from "../server/link/config";
import { onePasswordGet, onePasswordPost } from "../server/onepassword/http";
import { ExtensionError } from "../server/onepassword/extension";
import { createOnePasswordAuth } from "../agent/lib/onepassword-auth";
import { closeBrowserRuntime, runBrowserOperation } from "../agent/lib/browser-runtime";
import { quarantineBrowser } from "../server/browser/privacy-lock";
import { ContextContainer, contextStorage } from "../node_modules/eve/dist/src/context/container.js";
import { AuthKey, SessionIdKey, SessionKey } from "../node_modules/eve/dist/src/context/keys.js";
import { CallbackBaseUrlKey, PendingAuthorizationResultKey, isAuthorizationSignal } from "../node_modules/eve/dist/src/harness/authorization.js";
import { createAuthorizationExecution } from "../node_modules/eve/dist/src/runtime/connections/scoped-authorization.js";

const databaseUrl = process.env.TEST_ONEPASSWORD_DATABASE_URL;
const integrationKey = (user = "user", account = "account") => `ops_${Buffer.from(JSON.stringify({ ver: 1, typ: "oauth_integration_key", key: "b".repeat(64), path: `//api.1password.com/oauth-clients/client/accounts/${account}/users/${user}` })).toString("base64url")}`;
// Every run uses its own schema and synthetic credentials; no provider network calls.
describe.skipIf(!databaseUrl)("1Password OAuth and approval lifecycle with PostgreSQL", () => {
  const schema = `op_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, config: Config, store: OnePasswordStore, oauth: OnePasswordOAuth, now: number;
  let principal: { type: "user"; issuer: string; id: string }, callback: string;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  const tokens = (suffix = "first", user = "user") => ({ access_token: `access-${suffix}`, refresh_token: `refresh-${suffix}`, expires_in: 900, token_type: "Bearer", scope: scopes, user_id: user, account_id: "account" });
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
    await pool.query(await readFile(new URL("../migrations/002_onepassword.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../migrations/003_link_checkout.sql", import.meta.url), "utf8"));
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.stubEnv("ONEPASSWORD_ENABLED", "true");
    now = Date.now();
    principal = { type: "user", issuer: "linq", id: `linq:${randomUUID()}` };
    config = { origin: "https://bell.example", redirectUri: "https://bell.example/api/onepassword/callback", clientId: "client", clientSecret: "secret", encryptionKey: randomBytes(32), databaseUrl: databaseUrl! };
    callback = `https://bell.example/eve/v1/connections/onepassword/callback/${randomUUID()}/hook`;
    store = new OnePasswordStore(pool, config.encryptionKey);
    fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(tokens()));
    oauth = new OnePasswordOAuth(config, store, fetcher, () => now);
  });
  const credentials = <T>(service: OnePasswordOAuth, operation: (access: string, key: string) => Promise<T>) => service.store.withOwner(ownerOf(principal), async db => {
    const keys = await service.activeCredentials(db, await db.read());
    return operation(keys.accessToken, keys.integrationKey);
  });
  async function begin(callbackUrl = callback) {
    const started = await oauth.start(principal, callbackUrl), state = new URL(started.challenge.url).searchParams.get("state")!;
    const response = await onePasswordGet(new Request(started.challenge.url), "start", () => oauth);
    expect(response.status).toBe(303);
    return { started, state, cookie: response.headers.get("set-cookie")!, url: new URL(response.headers.get("location")!) };
  }
  async function capture(flow: Awaited<ReturnType<typeof begin>>, key: string | undefined = integrationKey()) {
    return onePasswordPost(new Request(`${config.origin}/api/onepassword/complete`, { method: "POST", headers: { cookie: flow.cookie, origin: config.origin, "content-type": "application/json" }, body: JSON.stringify({ state: flow.state, code: "code", ...(key ? { integrationKey: key } : {}) }) }), "complete", () => oauth);
  }
  async function connect() {
    const flow = await begin();
    const response = await capture(flow);
    expect(response.status).toBe(200);
    const target = new URL((await response.json()).location);
    const marker = await oauth.complete(principal, callback, flow.started.resume, Object.fromEntries(target.searchParams));
    return { flow, marker, target };
  }
  it("connects through the HTTP callback, keeps secrets encrypted, and resumes with only an opaque marker", async () => {
    const { flow, marker, target } = await connect();
    expect(flow.url.origin).toBe("https://my.1password.com");
    const body = fetcher.mock.calls[0][1]!.body as URLSearchParams;
    expect(hash(body.get("code_verifier")!)).toBe(flow.url.searchParams.get("code_challenge"));
    expect(body.get("client_secret")).toBeNull();
    expect(JSON.stringify(marker)).not.toMatch(/access-first|refresh-first|ops_/);
    const rows = await pool.query("SELECT encrypted_state FROM bell_onepassword_connections WHERE owner=$1", [ownerOf(principal)]);
    expect(JSON.stringify(rows.rows)).not.toMatch(/access-first|refresh-first|ops_/);
    const restarted = new OnePasswordOAuth(config, new OnePasswordStore(pool, config.encryptionKey), fetcher, () => now);
    expect(await restarted.complete(principal, callback, flow.started.resume, Object.fromEntries(target.searchParams))).toEqual(marker);
    expect(await credentials(restarted, async access => access)).toBe("access-first");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects another sender and a mismatched browser before a code exchange", async () => {
    const flow = await begin();
    await expect(oauth.capture({ state: flow.state, code: "code", integrationKey: integrationKey() }, "wrong-cookie")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    const response = await capture(flow), target = new URL((await response.json()).location);
    await expect(oauth.complete({ ...principal, id: "linq:other" }, callback, flow.started.resume, Object.fromEntries(target.searchParams))).rejects.toThrow();
  });
  it("retains the one-time key across a failed exchange and a reconnect without a fragment", async () => {
    const flow = await begin();
    fetcher.mockRejectedValueOnce(new Error("synthetic response loss"));
    expect((await capture(flow)).status).toBe(400);
    expect((await capture(flow)).status).toBe(400);
    expect(fetcher).toHaveBeenCalledOnce();
    const second = await begin(callback.replace("/hook", "/retry"));
    expect((await capture(second, "")).status).toBe(200);
    expect(await credentials(oauth, async (_, key) => key)).toBe(integrationKey());
  });
  it("retains an already-captured key when disconnect cannot yet revoke an uncertain exchange", async () => {
    const flow = await begin();
    fetcher.mockRejectedValueOnce(new Error("lost exchange"));
    expect((await capture(flow)).status).toBe(400);
    await expect(oauth.disconnect(principal)).rejects.toThrow();
    expect(await store.withOwner(ownerOf(principal), db => db.read())).toHaveProperty("integrationKey", integrationKey());
  });
  it("finishes a denied OAuth authorization without exchanging credentials", async () => {
    const flow = await begin();
    const nonce = flow.cookie.split("=")[1].split(";")[0];
    const target = new URL(await oauth.capture({ state: flow.state, error: "access_denied" }, nonce));
    await expect(oauth.complete(principal, callback, flow.started.resume, Object.fromEntries(target.searchParams))).rejects.toMatchObject({ reason: "authorization_denied" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("never activates a callback without a key, or reuses a key for a different provider user", async () => {
    const flow = await begin();
    expect((await capture(flow, "")).status).toBe(400);
    await expect(oauth.getToken(principal)).rejects.toThrow();
    fetcher.mockImplementation(async () => Response.json(tokens()));
    const second = await begin(callback.replace("/hook", "/retry"));
    expect((await capture(second)).status).toBe(200);
    const third = await begin(callback.replace("/hook", "/different"));
    fetcher.mockImplementation(async () => Response.json(tokens("different", "other-user")));
    expect((await capture(third, "")).status).toBe(400);
    await expect(oauth.getToken(principal)).rejects.toThrow();
  });
  it("serializes refreshes across instances and never reuses a possibly consumed refresh token", async () => {
    await connect(); now += 850_000;
    fetcher.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return Response.json(tokens("rotated")); });
    const other = new OnePasswordOAuth(config, new OnePasswordStore(pool, config.encryptionKey), fetcher, () => now);
    const read = (service: OnePasswordOAuth) => credentials(service, async access => access);
    expect(await Promise.all([read(oauth), read(other), read(oauth)])).toEqual(["access-rotated", "access-rotated", "access-rotated"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 850_000;
    fetcher.mockRejectedValue(new Error("lost refresh response"));
    await expect(read(oauth)).rejects.toThrow();
    await expect(read(other)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("blocks access during failed revocation and allows a revocation retry", async () => {
    await connect();
    fetcher.mockImplementation(async () => new Response(null, { status: 503 }));
    await expect(oauth.disconnect(principal)).rejects.toThrow();
    await expect(credentials(oauth, async () => true)).rejects.toThrow();
    fetcher.mockImplementation(async () => Response.json({}));
    expect(await oauth.disconnect(principal)).toEqual({ status: "disconnected" });
    expect(fetcher.mock.calls.at(-1)![0]).toBe("https://api.1password.com/v1alpha1/oauth-integrations/self:revoke");
    expect(await store.withOwner(ownerOf(principal), db => db.read())).not.toHaveProperty("integrationKey");
  });
  it("rejects ciphertext swapped between owners", async () => {
    await connect();
    await pool.query("INSERT INTO bell_onepassword_connections(owner,encrypted_state) SELECT $1,encrypted_state FROM bell_onepassword_connections WHERE owner=$2", [ownerOf({ ...principal, id: "linq:other" }), ownerOf(principal)]);
    await expect(oauth.getToken({ ...principal, id: "linq:other" })).rejects.toThrow();
  });
  async function startLogin(check: ConstructorParameters<typeof OnePasswordLogin>[1]) {
    await connect();
    const service = new OnePasswordLogin(oauth, check, () => now), id = loginId("session", "call");
    const created = vi.fn(async () => ({ browserSessionId: "browser-id", requestId: "request-id", entryId: "entry-id", appLink: "onepassword://approve/synthetic" }));
    const input = { loginUrl: "https://example.com/login", successUrl: "https://example.com/home" };
    const started = await service.start(principal, "session", id, input, callback, created);
    return { service, id, started, cap: new URL(started.challenge.url).hash.slice(1), created };
  }
  it("binds approval to the requested entry and conversation, then fills once on durable replay", async () => {
    const check = vi.fn(async () => ({ state: "resolved", resolved: [{ entryId: "unrelated", reference: "wrong" }, { entryId: "entry-id", reference: "approved-reference" }] }));
    const { service, id, cap, started } = await startLogin(check);
    await expect(service.poll(cap, false)).rejects.toThrow();
    await service.opened(cap); now += 5000;
    const approved = await service.poll(cap, false);
    const target = new URL(approved.location!);
    await service.complete(principal, id, callback, started.resume, Object.fromEntries(target.searchParams));
    const fill = vi.fn(async (_credentials, request) => { expect(request.reference).toBe("approved-reference"); });
    await expect(service.fill(principal, id, "other-session", fill)).rejects.toThrow();
    expect(fill).not.toHaveBeenCalled();
    expect(await service.fill(principal, id, "session", fill)).toMatchObject({ status: "destination_verified" });
    expect(await service.fill(principal, id, "session", fill)).toMatchObject({ status: "destination_verified" });
    expect(fill).toHaveBeenCalledOnce();
    const saved = await store.withOwner(ownerOf(principal), db => db.read());
    expect(saved.login?.status).toBe("filled");
    expect(saved.login).not.toHaveProperty("reference");
  });
  it("enforces one checker, respects rate limits, and stops automatic polling after two minutes", async () => {
    const check = vi.fn(async () => ({ state: "pending" }));
    const { service, cap } = await startLogin(check);
    await service.opened(cap); now += 5000;
    check.mockRejectedValueOnce(new ExtensionError("rateLimitExceeded"));
    expect(await service.poll(cap, false)).toMatchObject({ retryAfter: 60 });
    await Promise.all([service.poll(cap, false), service.poll(cap, false)]);
    expect(check).toHaveBeenCalledOnce();
    now += 121_000;
    expect(await service.poll(cap, false)).toMatchObject({ status: "waiting_for_user" });
    expect(check).toHaveBeenCalledOnce();
    await service.poll(cap, true);
    expect(check).toHaveBeenCalledTimes(2);
  });
  it("never fills a missing/skipped grant or after disconnect", async () => {
    const { service, id, cap } = await startLogin(async () => ({ state: "resolved", resolved: [{ entryId: "other", reference: "not-ours" }] }));
    await service.opened(cap); now += 5000;
    expect(await service.poll(cap, false)).toMatchObject({ status: "not_approved" });
    const fill = vi.fn();
    await expect(service.fill(principal, id, "session", fill)).rejects.toThrow();
    fetcher.mockImplementation(async () => Response.json({}));
    await oauth.disconnect(principal);
    await expect(service.fill(principal, id, "session", fill)).rejects.toThrow();
    expect(fill).not.toHaveBeenCalled();
  });
  it("blocks later browser reads after an interrupted fill and serializes operations across workers", async () => {
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    vi.stubEnv("DATABASE_URL", url.href);
    vi.stubEnv("BROWSERBASE_1PASSWORD_EXTENSION_ID", "synthetic-extension");
    const sessionId = randomUUID(), order: string[] = [];
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const first = withPersonalBrowserLock(sessionId, async () => { order.push("fill-start"); started(); await new Promise(resolve => setTimeout(resolve, 20)); order.push("fill-end"); });
    await ready;
    await Promise.all([first, withPersonalBrowserLock(sessionId, async () => { order.push("read"); })]);
    expect(order).toEqual(["fill-start", "fill-end", "read"]);
    await expect(withPersonalBrowserLock(sessionId, async () => { await markSecretFill(true); throw new Error("process lost"); })).rejects.toThrow();
    const read = vi.fn();
    await expect(withPersonalBrowserLock(sessionId, read)).rejects.toThrow("Start a new conversation");
    expect(read).not.toHaveBeenCalled();
    await expect(withPersonalBrowserLock(randomUUID(), async () => "clean browser")).resolves.toBe("clean browser");
  });
  it.each(["onepassword", "link"])("keeps %s quarantine enforced when both integrations share the runtime", async integration => {
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    vi.stubEnv("DATABASE_URL", url.href);
    vi.stubEnv("LINK_SANDBOX", "0");
    vi.stubEnv("LINK_CLIENT_ID", "synthetic-client");
    vi.stubEnv("BROWSERBASE_1PASSWORD_EXTENSION_ID", "synthetic-extension");
    const sessionId = randomUUID(), read = vi.fn();
    await contextStorage.run(new ContextContainer(), async () => {
      try {
        await expect(runBrowserOperation(sessionId, async () => {
          await markSecretFill(true);
          if (integration === "link") { await markSecretFill(false); await quarantineBrowser(); }
          throw new Error("interrupted private operation");
        })).rejects.toThrow("interrupted private operation");
        await expect(runBrowserOperation(sessionId, read)).rejects.toThrow(integration === "link" ? "Payment details may remain" : "Start a new conversation");
        expect(read).not.toHaveBeenCalled();
      } finally { await closeBrowserRuntime(sessionId); }
    });
  });
  it("resumes Eve in the original authenticated session without journaling provider credentials", async () => {
    const context = new ContextContainer(), auth = { principalType: "user" as const, principalId: principal.id, issuer: "linq", authenticator: "linq-message", attributes: {} };
    context.set(AuthKey, auth); context.set(SessionIdKey, "original-session"); context.set(SessionKey, { sessionId: "original-session", auth: { current: auth } } as never); context.set(CallbackBaseUrlKey, config.origin);
    const scoped = { scope: "onepassword", authorization: createOnePasswordAuth(() => oauth), connection: { url: "" } };
    await contextStorage.run(context, async () => {
      const execution = createAuthorizationExecution(), signal = await execution.run(() => execution.getToken(scoped));
      if (!isAuthorizationSignal(signal)) throw new Error("Expected Eve authorization pause");
      const challenge = signal.challenges[0];
      expect(JSON.stringify(challenge.resume)).not.toMatch(/verifier|ops_|refresh/);
      const state = new URL(challenge.challenge.url!).searchParams.get("state")!;
      await oauth.open(state, "browser-nonce");
      const target = new URL(await oauth.capture({ state, code: "code", integrationKey: integrationKey() }, "browser-nonce"));
      context.set(PendingAuthorizationResultKey, [{ name: challenge.name, attemptId: challenge.attemptId, instanceId: challenge.instanceId, principal: challenge.principal, resume: challenge.resume, hookUrl: challenge.hookUrl, callback: { method: "GET", params: Object.fromEntries(target.searchParams) } }]);
      const result = await createAuthorizationExecution().getToken(scoped);
      expect(result.token).toMatch(/^onepassword-connected-/);
      expect(context.require(SessionIdKey)).toBe("original-session");
    });
  });
});
