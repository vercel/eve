import { describe, expect, it } from "vitest";

import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { evictScopedToken, resolveScopedToken } from "#runtime/connections/scoped-authorization.js";
import { loadContext } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import {
  CallbackBaseUrlKey,
  PendingAuthorizationResultKey,
  isAuthorizationSignal,
} from "#harness/authorization.js";
import { isConnectionAuthorizationFailedError } from "#public/connections/errors.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import type { ToolContext } from "#public/definitions/tool.js";
import type {
  AuthorizationDefinition,
  ConnectionPrincipal,
  TokenResult,
} from "#runtime/connections/types.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";

/**
 * Integration coverage for tool-hosted authorization: the
 * {@link createToolExecuteWithAuth} wrapper drives token resolution,
 * the per-step cache, the park-on-`Required` flow, callback completion
 * on resume, and the loop guard — all scoped by the tool's name.
 */

const REQUIRED_ERROR = "ConnectionAuthorizationRequiredError";

function requiredError(): Error {
  const err = new Error("auth required");
  err.name = REQUIRED_ERROR;
  return err;
}

/**
 * Seeds an authenticated user principal and a session id on the active
 * context so `principalType: "user"` strategies resolve a principal and
 * `getHookUrl` can mint a callback URL. Mirrors what the runtime
 * projects from the channel session.
 */
function seedUserPrincipal(): void {
  const ctx = loadContext();
  ctx.set(SessionIdKey, "session_auth");
  ctx.set(AuthKey, {
    attributes: {},
    authenticator: "test-idp",
    issuer: "test-idp",
    principalId: "user-1",
    principalType: "user",
  });
}

function authoredTool(input: {
  readonly name: string;
  readonly execute: (toolInput: unknown, ctx: ToolContext) => unknown;
}): ResolvedToolDefinition {
  const logicalPath = `tools/${input.name}.ts`;
  return {
    description: `${input.name} auth tool.`,
    execute: createToolExecuteWithAuth({
      execute: input.execute as (toolInput: unknown, ctx: unknown) => unknown,
      scope: input.name,
    }),
    inputSchema: null,
    logicalPath,
    name: input.name,
    sourceId: logicalPath,
    sourceKind: "module",
  };
}

describe("tool-hosted authorization", () => {
  it("resolves and caches the bearer through ctx.getToken(provider)", async () => {
    let calls = 0;
    const auth: AuthorizationDefinition = {
      principalType: "app",
      async getToken(): Promise<TokenResult> {
        calls += 1;
        return { token: `tok-${calls}` };
      },
    };
    const tool = authoredTool({
      name: "list_groups",
      async execute(_input, ctx) {
        const first = await ctx.getToken(auth);
        const second = await ctx.getToken(auth);
        return { first: first.token, second: second.token };
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    const result = await runtime.runAsSession(undefined, async () => runtime.executeTool(tool, {}));

    // Both reads return the same cached token; getToken ran once.
    expect(result).toEqual({ first: "tok-1", second: "tok-1" });
    expect(calls).toBe(1);
  });

  it("exposes the tool call metadata on the authored context", async () => {
    const tool = authoredTool({
      name: "observe_call_metadata",
      execute(_input, ctx) {
        return { callId: ctx.callId, toolName: ctx.toolName };
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    const result = await runtime.runAsSession(undefined, async () => runtime.executeTool(tool, {}));

    // The test harness dispatches every executeTool call as "call_test".
    expect(result).toEqual({ callId: "call_test", toolName: "observe_call_metadata" });
  });

  it("resolves and caches an inline provider on a plain tool", async () => {
    let calls = 0;
    const inlineAuth: AuthorizationDefinition = {
      principalType: "app",
      async getToken(): Promise<TokenResult> {
        calls += 1;
        return { token: `inline-${calls}` };
      },
    };
    const tool = authoredTool({
      name: "sync_ticket",
      async execute(_input, ctx) {
        const first = await ctx.getToken(inlineAuth);
        const second = await ctx.getToken(inlineAuth);
        return { first: first.token, second: second.token };
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    const result = await runtime.runAsSession(undefined, async () => runtime.executeTool(tool, {}));

    expect(result).toEqual({ first: "inline-1", second: "inline-1" });
    expect(calls).toBe(1);
  });

  it("keeps explicit auth keys separate for anonymous inline providers", async () => {
    const githubAuth: AuthorizationDefinition = {
      principalType: "app",
      async getToken(): Promise<TokenResult> {
        return { token: "github-token" };
      },
    };
    const linearAuth: AuthorizationDefinition = {
      principalType: "app",
      async getToken(): Promise<TokenResult> {
        return { token: "linear-token" };
      },
    };
    const tool = authoredTool({
      name: "sync_ticket",
      async execute(_input, ctx) {
        const github = await ctx.getToken(githubAuth, { authKey: "github" });
        const linear = await ctx.getToken(linearAuth, { authKey: "linear" });
        return { github: github.token, linear: linear.token };
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    const result = await runtime.runAsSession(undefined, async () => runtime.executeTool(tool, {}));

    expect(result).toEqual({ github: "github-token", linear: "linear-token" });
  });

  it("rejects multiple anonymous inline providers without explicit auth keys", async () => {
    const githubAuth: AuthorizationDefinition = {
      principalType: "app",
      async getToken(): Promise<TokenResult> {
        return { token: "github-token" };
      },
    };
    const linearAuth: AuthorizationDefinition = {
      principalType: "app",
      async getToken(): Promise<TokenResult> {
        return { token: "linear-token" };
      },
    };
    const tool = authoredTool({
      name: "sync_ticket",
      async execute(_input, ctx) {
        await ctx.getToken(githubAuth);
        await ctx.getToken(linearAuth);
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    await expect(
      runtime.runAsSession(undefined, async () => runtime.executeTool(tool, {})),
    ).rejects.toThrow(/explicit auth keys/);
  });

  it("rejects no-provider token access at runtime", async () => {
    const tool = authoredTool({
      name: "plain_tool",
      async execute(_input, ctx) {
        return await (ctx.getToken as () => Promise<TokenResult>)();
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    await expect(
      runtime.runAsSession(undefined, async () => runtime.executeTool(tool, {})),
    ).rejects.toThrow(/Pass an auth provider/);
  });

  it("parks the turn with a challenge for an inline provider", async () => {
    const inlineAuth: AuthorizationDefinition = {
      principalType: "user",
      vercelConnect: { connector: "oauth/linear" },
      async getToken(): Promise<TokenResult> {
        throw requiredError();
      },
      async startAuthorization() {
        return { challenge: { url: "https://idp.example/auth" }, resume: { nonce: "n1" } };
      },
      async completeAuthorization(): Promise<TokenResult> {
        return { token: "after-signin" };
      },
    };
    const tool = authoredTool({
      name: "sync_ticket",
      async execute(_input, ctx) {
        return await ctx.getToken(inlineAuth, { displayName: "Linear" });
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    const result = await runtime.runAsSession(
      { sessionId: "session_inline_auth_park" },
      async () => {
        seedUserPrincipal();
        loadContext().set(CallbackBaseUrlKey, "https://app.example");
        return runtime.executeTool(tool, {});
      },
    );

    expect(isAuthorizationSignal(result)).toBe(true);
    if (!isAuthorizationSignal(result)) throw new Error("expected signal");
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0]).toMatchObject({
      name: "sync_ticket__oauth_linear",
      challenge: { displayName: "Linear", url: "https://idp.example/auth" },
    });
  });

  it("uses a localhost callback URL for a Vercel Connect inline provider", async () => {
    let receivedCallbackUrl: string | undefined;
    const inlineAuth: AuthorizationDefinition = {
      principalType: "user",
      vercelConnect: { connector: "mcp.notion.com/notion" },
      async getToken(): Promise<TokenResult> {
        throw requiredError();
      },
      async startAuthorization({ callbackUrl }) {
        receivedCallbackUrl = callbackUrl;
        return { challenge: { url: "https://idp.example/auth" } };
      },
      async completeAuthorization(): Promise<TokenResult> {
        return { token: "after-signin" };
      },
    };
    const tool = authoredTool({
      name: "search_notion",
      async execute(_input, ctx) {
        return await ctx.getToken(inlineAuth);
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    const result = await runtime.runAsSession(
      { sessionId: "session_connect_callback" },
      async () => {
        seedUserPrincipal();
        loadContext().set(CallbackBaseUrlKey, "http://[::1]:2000");
        return runtime.executeTool(tool, {});
      },
    );

    expect(isAuthorizationSignal(result)).toBe(true);
    if (!isAuthorizationSignal(result)) throw new Error("expected signal");
    expect(receivedCallbackUrl).toBe(
      "http://localhost:2000/eve/v1/connections/search_notion__mcp.notion.com_notion/callback/session_auth%3Aauth",
    );
    expect(result.challenges[0]?.hookUrl).toBe(receivedCallbackUrl);
  });

  it("parks the turn with a challenge when getToken throws Required", async () => {
    const auth: AuthorizationDefinition = {
      principalType: "user",
      async getToken(): Promise<TokenResult> {
        throw requiredError();
      },
      async startAuthorization() {
        return { challenge: { url: "https://idp.example/auth" }, state: { nonce: "n1" } };
      },
      async completeAuthorization(): Promise<TokenResult> {
        return { token: "after-signin" };
      },
    };
    const tool = authoredTool({
      name: "list_groups",
      async execute(_input, ctx) {
        return await ctx.getToken(auth);
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    const result = await runtime.runAsSession({ sessionId: "session_auth_park" }, async () => {
      seedUserPrincipal();
      loadContext().set(CallbackBaseUrlKey, "https://app.example");
      return runtime.executeTool(tool, {});
    });

    expect(isAuthorizationSignal(result)).toBe(true);
    if (!isAuthorizationSignal(result)) throw new Error("expected signal");
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0]).toMatchObject({
      name: "list_groups__inline_auth",
      challenge: { url: "https://idp.example/auth" },
    });
  });

  it("stamps the provider displayName onto the challenge, winning over the strategy's", async () => {
    const auth: AuthorizationDefinition = {
      displayName: "Salesforce",
      principalType: "user",
      async getToken(): Promise<TokenResult> {
        throw requiredError();
      },
      async startAuthorization() {
        return {
          challenge: { displayName: "Strategy Default", url: "https://idp.example/auth" },
        };
      },
      async completeAuthorization(): Promise<TokenResult> {
        return { token: "after-signin" };
      },
    };
    const tool = authoredTool({
      name: "sfdc_lookup",
      async execute(_input, ctx) {
        return await ctx.getToken(auth);
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    const result = await runtime.runAsSession({ sessionId: "session_display_name" }, async () => {
      seedUserPrincipal();
      loadContext().set(CallbackBaseUrlKey, "https://app.example");
      return runtime.executeTool(tool, {});
    });

    expect(isAuthorizationSignal(result)).toBe(true);
    if (!isAuthorizationSignal(result)) throw new Error("expected signal");
    // Identity stays the path-derived scope; only the presentation name changes.
    expect(result.challenges[0]).toMatchObject({
      name: "sfdc_lookup__inline_auth",
      challenge: { displayName: "Salesforce", url: "https://idp.example/auth" },
    });
  });

  it("keeps the strategy-stamped displayName when the definition has none", async () => {
    const auth: AuthorizationDefinition = {
      principalType: "user",
      async getToken(): Promise<TokenResult> {
        throw requiredError();
      },
      async startAuthorization() {
        return { challenge: { displayName: "Salesforce", url: "https://idp.example/auth" } };
      },
      async completeAuthorization(): Promise<TokenResult> {
        return { token: "after-signin" };
      },
    };
    const tool = authoredTool({
      name: "sfdc_lookup",
      async execute(_input, ctx) {
        return await ctx.getToken(auth);
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    const result = await runtime.runAsSession(
      { sessionId: "session_display_name_strategy" },
      async () => {
        seedUserPrincipal();
        loadContext().set(CallbackBaseUrlKey, "https://app.example");
        return runtime.executeTool(tool, {});
      },
    );

    expect(isAuthorizationSignal(result)).toBe(true);
    if (!isAuthorizationSignal(result)) throw new Error("expected signal");
    expect(result.challenges[0]?.challenge).toMatchObject({ displayName: "Salesforce" });
  });

  it("parks the turn when the tool calls ctx.requireAuth(provider)", async () => {
    const auth: AuthorizationDefinition = {
      principalType: "user",
      async getToken(): Promise<TokenResult> {
        return { token: "unused" };
      },
      async startAuthorization() {
        return { challenge: { url: "https://idp.example/auth" }, state: {} };
      },
      async completeAuthorization(): Promise<TokenResult> {
        return { token: "after-signin" };
      },
    };
    const tool = authoredTool({
      name: "gated_tool",
      execute(_input, ctx) {
        ctx.requireAuth(auth);
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    const result = await runtime.runAsSession({ sessionId: "session_require_auth" }, async () => {
      seedUserPrincipal();
      loadContext().set(CallbackBaseUrlKey, "https://app.example");
      return runtime.executeTool(tool, {});
    });

    expect(isAuthorizationSignal(result)).toBe(true);
  });

  it("completes the callback on resume and serves the minted token", async () => {
    let completeCalls = 0;
    const auth: AuthorizationDefinition = {
      principalType: "user",
      async getToken(): Promise<TokenResult> {
        // Without a cached token this strategy would require auth; the
        // resume path must satisfy getToken from the freshly minted
        // token cached by completeAuthorization.
        throw requiredError();
      },
      async startAuthorization() {
        return { challenge: { url: "https://idp.example/auth" }, state: {} };
      },
      async completeAuthorization(): Promise<TokenResult> {
        completeCalls += 1;
        return { token: "minted" };
      },
    };
    const tool = authoredTool({
      name: "list_groups",
      async execute(_input, ctx) {
        return await ctx.getToken(auth);
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    const result = await runtime.runAsSession({ sessionId: "session_resume" }, async () => {
      seedUserPrincipal();
      loadContext().set(CallbackBaseUrlKey, "https://app.example");
      loadContext().set(PendingAuthorizationResultKey, [
        {
          name: "list_groups__inline_auth",
          hookUrl: "https://app.example/callback",
          callback: {
            params: { code: "abc" },
            method: "GET",
          },
        },
      ]);
      return runtime.executeTool(tool, {});
    });

    expect(completeCalls).toBe(1);
    expect(result).toEqual({ token: "minted" });
  });

  it("completes an inline provider callback on resume and serves the minted token", async () => {
    let completeCalls = 0;
    const inlineAuth: AuthorizationDefinition = {
      principalType: "user",
      vercelConnect: { connector: "oauth/linear" },
      async getToken(): Promise<TokenResult> {
        throw requiredError();
      },
      async startAuthorization() {
        return { challenge: { url: "https://idp.example/auth" }, resume: {} };
      },
      async completeAuthorization(): Promise<TokenResult> {
        completeCalls += 1;
        return { token: "inline-minted" };
      },
    };
    const tool = authoredTool({
      name: "sync_ticket",
      async execute(_input, ctx) {
        return await ctx.getToken(inlineAuth);
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    const result = await runtime.runAsSession({ sessionId: "session_inline_resume" }, async () => {
      seedUserPrincipal();
      loadContext().set(CallbackBaseUrlKey, "https://app.example");
      loadContext().set(PendingAuthorizationResultKey, [
        {
          name: "sync_ticket__oauth_linear",
          hookUrl: "https://app.example/callback",
          callback: {
            params: { code: "abc" },
            method: "GET",
          },
        },
      ]);
      return runtime.executeTool(tool, {});
    });

    expect(completeCalls).toBe(1);
    expect(result).toEqual({ token: "inline-minted" });
  });

  it("maps inline ctx.requireAuth(auth) to eviction and a fresh challenge", async () => {
    const evicted: ConnectionPrincipal[] = [];
    const inlineAuth: AuthorizationDefinition = {
      principalType: "user",
      vercelConnect: { connector: "oauth/github" },
      async getToken(): Promise<TokenResult> {
        return { token: "stale" };
      },
      evict({ principal }) {
        evicted.push(principal);
      },
      async startAuthorization() {
        return { challenge: { url: "https://idp.example/auth" }, resume: {} };
      },
      async completeAuthorization(): Promise<TokenResult> {
        return { token: "fresh" };
      },
    };
    const tool = authoredTool({
      name: "sync_ticket",
      async execute(_input, ctx) {
        await ctx.getToken(inlineAuth);
        ctx.requireAuth(inlineAuth);
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    const result = await runtime.runAsSession({ sessionId: "session_inline_require" }, async () => {
      seedUserPrincipal();
      loadContext().set(CallbackBaseUrlKey, "https://app.example");
      return runtime.executeTool(tool, {});
    });

    expect(evicted).toHaveLength(1);
    expect(evicted[0]).toMatchObject({ type: "user" });
    expect(isAuthorizationSignal(result)).toBe(true);
    if (!isAuthorizationSignal(result)) throw new Error("expected signal");
    expect(result.challenges[0]).toMatchObject({
      name: "sync_ticket__oauth_github",
      challenge: { url: "https://idp.example/auth" },
    });
  });

  it("fails terminally when the token is rejected immediately after sign-in", async () => {
    const auth: AuthorizationDefinition = {
      principalType: "user",
      async getToken(): Promise<TokenResult> {
        return { token: "rejected" };
      },
      async startAuthorization() {
        return { challenge: { url: "https://idp.example/auth" }, state: {} };
      },
      async completeAuthorization(): Promise<TokenResult> {
        return { token: "rejected" };
      },
    };
    const tool = authoredTool({
      name: "list_groups",
      async execute(_input, ctx) {
        // The token resolves, but the downstream service rejects it —
        // the tool re-signals Required the same turn it signed in.
        await ctx.getToken(auth);
        ctx.requireAuth(auth);
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    const error = await runtime
      .runAsSession({ sessionId: "session_loop_guard" }, async () => {
        seedUserPrincipal();
        loadContext().set(CallbackBaseUrlKey, "https://app.example");
        loadContext().set(PendingAuthorizationResultKey, [
          {
            name: "list_groups__inline_auth",
            hookUrl: "https://app.example/callback",
            callback: {
              params: { code: "abc" },
              method: "GET",
            },
          },
        ]);
        return runtime.executeTool(tool, {});
      })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(isConnectionAuthorizationFailedError(error)).toBe(true);
  });

  it("fails terminally when an inline provider token is rejected immediately after sign-in", async () => {
    const inlineAuth: AuthorizationDefinition = {
      principalType: "user",
      vercelConnect: { connector: "oauth/github" },
      async getToken(): Promise<TokenResult> {
        return { token: "rejected" };
      },
      async startAuthorization() {
        return { challenge: { url: "https://idp.example/auth" }, resume: {} };
      },
      async completeAuthorization(): Promise<TokenResult> {
        return { token: "rejected" };
      },
    };
    const tool = authoredTool({
      name: "sync_ticket",
      async execute(_input, ctx) {
        await ctx.getToken(inlineAuth);
        ctx.requireAuth(inlineAuth);
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    const error = await runtime
      .runAsSession({ sessionId: "session_inline_loop_guard" }, async () => {
        seedUserPrincipal();
        loadContext().set(CallbackBaseUrlKey, "https://app.example");
        loadContext().set(PendingAuthorizationResultKey, [
          {
            name: "sync_ticket__oauth_github",
            hookUrl: "https://app.example/callback",
            callback: {
              params: { code: "abc" },
              method: "GET",
            },
          },
        ]);
        return runtime.executeTool(tool, {});
      })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(isConnectionAuthorizationFailedError(error)).toBe(true);
  });

  it("evictScopedToken drops the cached bearer so the next resolve re-fetches", async () => {
    let calls = 0;
    const auth: AuthorizationDefinition = {
      principalType: "user",
      async getToken(): Promise<TokenResult> {
        calls += 1;
        return { token: `tok-${calls}` };
      },
    };
    const scoped = { authorization: auth, connection: { url: "" }, scope: "list_groups" };
    const runtime = createTestRuntime({ tools: [] });

    const tokens = await runtime.runAsSession({ sessionId: "session_evict" }, async () => {
      seedUserPrincipal();
      // First resolve caches tok-1; eviction drops it so the next resolve
      // re-fetches (tok-2); the resolve after that is served from cache.
      const first = await resolveScopedToken(scoped);
      await evictScopedToken(scoped);
      const second = await resolveScopedToken(scoped);
      const third = await resolveScopedToken(scoped);
      return { first: first.token, second: second.token, third: third.token };
    });

    expect(tokens).toEqual({ first: "tok-1", second: "tok-2", third: "tok-2" });
    expect(calls).toBe(2);
  });

  it("evictScopedToken cascades to the strategy's own evict() with the resolved principal", async () => {
    const evicted: ConnectionPrincipal[] = [];
    const auth: AuthorizationDefinition = {
      principalType: "user",
      async getToken(): Promise<TokenResult> {
        return { token: "tok" };
      },
      evict({ principal }) {
        // A Connect-backed strategy would purge its in-process token
        // cache for this principal here; we just record the call.
        evicted.push(principal);
      },
    };
    const scoped = { authorization: auth, connection: { url: "" }, scope: "list_groups" };
    const runtime = createTestRuntime({ tools: [] });

    await runtime.runAsSession({ sessionId: "session_evict_cascade" }, async () => {
      seedUserPrincipal();
      await resolveScopedToken(scoped);
      await evictScopedToken(scoped);
    });

    expect(evicted).toHaveLength(1);
    expect(evicted[0]).toMatchObject({ type: "user" });
  });

  it("fails classified (not raw Required) for interactive auth when no callback URL can be minted", async () => {
    const auth: AuthorizationDefinition = {
      principalType: "user",
      async getToken(): Promise<TokenResult> {
        throw requiredError();
      },
      async startAuthorization() {
        return { challenge: { url: "https://idp.example/auth" }, state: {} };
      },
      async completeAuthorization(): Promise<TokenResult> {
        return { token: "after-signin" };
      },
    };
    const tool = authoredTool({
      name: "list_groups",
      async execute(_input, ctx) {
        return await ctx.getToken(auth);
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    // No CallbackBaseUrlKey set → getHookUrl returns undefined → no park
    // signal. The interactive path must NOT leak the raw Required into the
    // model; it surfaces a classified, terminal authorization failure.
    const err = await runtime
      .runAsSession({ sessionId: "session_no_url" }, async () => {
        seedUserPrincipal();
        return runtime.executeTool(tool, {});
      })
      .catch((e: unknown) => e);

    expect(isConnectionAuthorizationFailedError(err)).toBe(true);
    if (isConnectionAuthorizationFailedError(err)) {
      expect(err.reason).toBe("authorization_callback_unavailable");
      expect(err.retryable).toBe(false);
    }
  });

  it("rethrows raw Required for a non-interactive strategy", async () => {
    const auth: AuthorizationDefinition = {
      principalType: "user",
      async getToken(): Promise<TokenResult> {
        throw requiredError();
      },
    };
    const tool = authoredTool({
      name: "list_keys",
      async execute(_input, ctx) {
        return await ctx.getToken(auth);
      },
    });
    const runtime = createTestRuntime({ tools: [tool] });

    // Non-interactive strategies have no consent flow to park on, so the
    // model should see the original failure.
    await expect(
      runtime.runAsSession({ sessionId: "session_noninteractive" }, async () => {
        seedUserPrincipal();
        return runtime.executeTool(tool, {});
      }),
    ).rejects.toThrow("auth required");
  });
});
