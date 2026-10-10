import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readVercelCliToken } from "#internal/model-auth/vercel-cli.js";
import { provisionWebChatAuth } from "./provision-auth.js";

vi.mock("#internal/model-auth/vercel-cli.js", () => ({ readVercelCliToken: vi.fn() }));
const project = { orgId: "team_test", projectId: "prj_123" };
const app = {
  clientId: "cl_test",
  teamId: "team_test",
  signInFrom: "owning-team",
  scopes: ["openid", "email", "profile"],
  grantTypes: { authorization_code: true },
  clientAuthenticationMethods: { client_secret_post: true },
  projectRedirectUris: [{ projectId: "prj_123", path: "/api/auth/callback/vercel" }],
  clientSecrets: [],
};
const keys = ["VERCEL_APP_CLIENT_ID", "VERCEL_APP_CLIENT_SECRET", "BETTER_AUTH_SECRET"];
const completeEnvs = keys.map((key, i) => ({
  id: `env_${i}`,
  key,
  target: ["production", "preview"],
  value: i === 0 ? "cl_test" : undefined,
}));
const fetchMock = vi.fn<typeof fetch>();
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
function response(value: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(json(value, status));
}
function initial(envs: unknown[] = []) {
  response({ id: "prj_123", accountId: "team_test", name: "agent" });
  response({ envs });
}
function missingApp() {
  response({ error: { code: "invalid_client" } }, 400);
}
function writes() {
  return fetchMock.mock.calls.filter(([, options]) => options?.method !== "GET");
}
beforeEach(() => {
  vi.mocked(readVercelCliToken).mockResolvedValue("test-token");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("Web Chat auth provisioning", () => {
  it("creates a team-only app with project callbacks and sensitive credentials for both deployments", async () => {
    initial();
    missingApp();
    response(app);
    response({ clientId: "cl_test", clientSecret: "secret-value-1234" });
    response({ created: completeEnvs, failed: [] });

    await provisionWebChatAuth(project);

    const requests = writes();
    expect(JSON.parse(requests[0]![1]!.body as string)).toEqual({
      name: "agent Web Chat 123",
      slug: "agent-web-chat-123",
      signInFrom: "owning-team",
      scopes: ["openid", "email", "profile"],
      grantTypes: { authorization_code: true },
      clientAuthenticationMethods: { client_secret_post: true },
      projectRedirectUris: [{ projectId: "prj_123", path: "/api/auth/callback/vercel" }],
    });
    const variables = JSON.parse(requests[2]![1]!.body as string);
    expect(variables).toEqual([
      {
        key: keys[0],
        value: "cl_test",
        target: ["production", "preview"],
        type: "plain",
        visibility: "config",
      },
      {
        key: keys[1],
        value: "secret-value-1234",
        target: ["production", "preview"],
        type: "sensitive",
        visibility: "secret",
      },
      {
        key: keys[2],
        value: expect.any(String),
        target: ["production", "preview"],
        type: "sensitive",
        visibility: "secret",
      },
    ]);
    expect(Buffer.from(variables[2].value, "base64url")).toHaveLength(32);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(new URL(String(url)).searchParams.get("teamId")).toBe("team_test");
      expect(options?.redirect).toBe("error");
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("reuses builder-created apps by client ID without rotating secrets", async () => {
    initial(completeEnvs);
    response({ app: { ...app, slug: "random-builder-slug" } });
    await provisionWebChatAuth(project);
    expect(String(fetchMock.mock.calls[2]![0])).toContain("/oauth-apps/cl_test?");
    expect(writes()).toEqual([]);
  });

  it("fills missing preview credentials without changing production", async () => {
    initial(completeEnvs.map((env) => ({ ...env, target: ["production"] })));
    response({ app });
    response({ clientSecret: "preview-secret-5678" });
    response({ created: [], failed: [] });
    await provisionWebChatAuth(project);
    expect(
      JSON.parse(writes()[1]![1]!.body as string).map((env: { target: string[] }) => env.target),
    ).toEqual([["preview"], ["preview"], ["preview"]]);
  });

  it("does not mistake branch overrides for general preview credentials", async () => {
    initial(completeEnvs.map((env) => ({ ...env, gitBranch: "feature", target: ["preview"] })));
    response({ app });
    response({ clientSecret: "new-secret-5678" });
    response({ created: [], failed: [] });
    await provisionWebChatAuth(project);
    expect(writes()).toHaveLength(2);
  });

  it.each([
    { teamId: "team_other" },
    { signInFrom: "any-team" },
    { projectRedirectUris: [{ projectId: "prj_other", path: "/api/auth/callback/vercel" }] },
    { scopes: ["openid"] },
    { clientAuthenticationMethods: { client_secret_basic: true } },
  ])("refuses incompatible apps without changing their access: %j", async (mismatch) => {
    initial();
    response({ app: { ...app, ...mismatch } });
    await expect(provisionWebChatAuth(project)).rejects.toThrow("does not match");
    expect(writes()).toEqual([]);
  });

  it.each([false, true])("gives recovery specific to a configured app (%s)", async (configured) => {
    initial(configured ? completeEnvs : []);
    response({ app: { ...app, teamId: "team_other" } });
    await expect(provisionWebChatAuth(project)).rejects.toThrow(
      configured ? "Check VERCEL_APP_CLIENT_ID" : "Rename the Vercel project",
    );
    expect(writes()).toEqual([]);
  });

  it("rejects credentials for different apps across environments", async () => {
    initial([
      { ...completeEnvs[0], target: ["production"] },
      { ...completeEnvs[0], id: "env_other", value: "cl_other", target: ["preview"] },
    ]);
    await expect(provisionWebChatAuth(project)).rejects.toThrow("conflicting or incomplete");
    expect(writes()).toEqual([]);
  });

  it("does not attach an unknown existing secret to a newly created app", async () => {
    initial([completeEnvs[1]]);
    await expect(provisionWebChatAuth(project)).rejects.toThrow("conflicting or incomplete");
    expect(writes()).toEqual([]);
  });

  it("checks project ownership before creating any resource", async () => {
    response({ id: "prj_123", accountId: "team_other", name: "agent" });
    await expect(provisionWebChatAuth(project)).rejects.toThrow("selected team");
    expect(writes()).toEqual([]);
  });

  it.each([
    ["app_slug_taken", 409],
    ["app_limit_reached", 400],
  ] as const)(
    "reuses a matching app after concurrent creation returns %s",
    async (code, status) => {
      initial();
      missingApp();
      response({ error: { code } }, status);
      response({ app });
      response({ clientSecret: "new-secret-5678" });
      response({ created: completeEnvs, failed: [] });
      await expect(provisionWebChatAuth(project)).resolves.toBeUndefined();
    },
  );

  it("rolls back only acknowledged env writes and identifies the new secret by its last four characters", async () => {
    initial();
    response({ app });
    response({ clientSecret: "new-secret-5678" });
    response({ created: [completeEnvs[0]], failed: [{ error: { message: "conflict" } }] });
    response({});
    response({});
    await expect(provisionWebChatAuth(project)).rejects.toThrow("Could not save");
    const deletes = fetchMock.mock.calls.filter(([, options]) => options?.method === "DELETE");
    expect(deletes.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/v9/projects/prj_123/env/env_0",
      "/oauth-apps/cl_test/secret/5678",
    ]);
  });

  it.each([400, 403])(
    "removes the new secret after a definitive env rejection (%s)",
    async (status) => {
      initial();
      response({ app });
      response({ clientSecret: "new-secret-5678" });
      response({ error: { code: "rejected", message: "private-response-data" } }, status);
      response({});
      await expect(provisionWebChatAuth(project)).rejects.toThrow(
        status === 403 ? "Vercel denied" : "Vercel could not configure",
      );
      const deletes = fetchMock.mock.calls.filter(([, options]) => options?.method === "DELETE");
      expect(deletes.map(([url]) => new URL(String(url)).pathname)).toEqual([
        "/oauth-apps/cl_test/secret/5678",
      ]);
    },
  );

  it("attempts all acknowledged cleanup even if an env deletion fails", async () => {
    initial();
    response({ app });
    response({ clientSecret: "new-secret-5678" });
    response({ created: [completeEnvs[0], completeEnvs[2]], failed: [{}] });
    response({ error: { code: "forbidden", message: "private-response-data" } }, 403);
    response({});
    response({});
    await expect(provisionWebChatAuth(project)).rejects.toThrow("Cleanup was incomplete");
    const deletes = fetchMock.mock.calls.filter(([, options]) => options?.method === "DELETE");
    expect(deletes.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/v9/projects/prj_123/env/env_0",
      "/v9/projects/prj_123/env/env_2",
      "/oauth-apps/cl_test/secret/5678",
    ]);
  });

  it("keeps a saved secret when its environment variable cannot be rolled back", async () => {
    initial();
    response({ app });
    response({ clientSecret: "new-secret-5678" });
    response({ created: [completeEnvs[0], completeEnvs[1]], failed: [{}] });
    response({});
    response({ error: { code: "forbidden" } }, 403);
    await expect(provisionWebChatAuth(project)).rejects.toThrow("Cleanup was incomplete");
    expect(
      fetchMock.mock.calls.some(
        ([url, options]) => options?.method === "DELETE" && String(url).includes("/secret/"),
      ),
    ).toBe(false);
  });

  it("keeps the secret when an env write may have committed before the response was lost", async () => {
    initial();
    response({ app });
    response({ clientSecret: "new-secret-5678" });
    fetchMock.mockRejectedValueOnce(new Error("connection lost"));
    await expect(provisionWebChatAuth(project)).rejects.toThrow("Retry");
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);
  });

  it.each([500, 502])(
    "keeps the secret after an ambiguous env server failure (%s)",
    async (status) => {
      initial();
      response({ app });
      response({ clientSecret: "new-secret-5678" });
      response({ error: { code: "server_error" } }, status);
      await expect(provisionWebChatAuth(project)).rejects.toThrow("Retry");
      expect(fetchMock.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);
    },
  );

  it("reports access errors without echoing tokens or server response details", async () => {
    response({ error: { code: "forbidden", message: "secret-response-data" } }, 403);
    await expect(provisionWebChatAuth(project)).rejects.toThrow("Run `vercel login`");
    expect(writes()).toEqual([]);
  });

  it.each(["app_name_taken", "app_slug_taken"])(
    "explains recovery from %s without writing credentials",
    async (code) => {
      initial();
      missingApp();
      response({ error: { code, message: "private-server-detail" } }, 409);
      missingApp();
      await expect(provisionWebChatAuth(project)).rejects.toThrow("Rename the Vercel project");
      expect(writes()).toHaveLength(1);
    },
  );

  it("reports the team app limit without creating credentials", async () => {
    initial();
    missingApp();
    response({ error: { code: "app_limit_reached" } }, 400);
    missingApp();
    await expect(provisionWebChatAuth(project)).rejects.toThrow("Remove an unused app");
    expect(writes()).toHaveLength(1);
  });

  it("preserves the collision diagnosis when rereading the app is denied", async () => {
    initial();
    missingApp();
    response({ error: { code: "app_slug_taken" } }, 409);
    response({ error: { code: "forbidden" } }, 403);
    await expect(provisionWebChatAuth(project)).rejects.toThrow("Rename the Vercel project");
    expect(writes()).toHaveLength(1);
  });

  it("reports the app secret limit before generating another secret", async () => {
    initial();
    response({
      app: { ...app, clientSecrets: [{ lastFourChars: "1234" }, { lastFourChars: "5678" }] },
    });
    await expect(provisionWebChatAuth(project)).rejects.toThrow("client secret limit");
    expect(writes()).toEqual([]);
  });
});
