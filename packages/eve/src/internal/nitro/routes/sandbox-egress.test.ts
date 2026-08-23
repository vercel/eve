import { beforeEach, describe, expect, it, vi } from "vitest";

const writeFiles = vi.fn(async () => {});
const get = vi.fn(async () => ({
  currentSession: () => ({ sessionId: "sandbox-id" }),
  writeFiles,
}));
const logError = vi.fn(() => "error-id");

vi.mock("#compiled/@vercel/sandbox/index.js", () => ({ Sandbox: { get } }));
vi.mock("#compiled/@vercel/sandbox/proxy.js", () => ({
  defineSandboxProxy:
    (handler: (request: Request, meta: object) => Promise<Response>, invalid: () => Response) =>
    async (request: Request) =>
      request.headers.has("vercel-sandbox-oidc-token")
        ? await handler(request, {
            host: "api.example.com",
            projectId: "project",
            sandboxId: "sandbox-id",
            sandboxName: "sandbox-name",
            teamId: "team",
          })
        : invalid(),
}));
vi.mock("#execution/sandbox/bindings/vercel-credentials.js", () => ({
  getVercelSandboxCredentials: async () => ({
    projectId: "project",
    teamId: "team",
    token: "oidc",
  }),
  getVercelSandboxFetch: () => fetch,
}));
vi.mock("#internal/logging.js", () => ({
  createLogger: () => ({}),
  logError,
}));

const { default: sandboxEgressRoute } = await import("./sandbox-egress.js");

const DEMAND_TOKEN = "a".repeat(43);

describe("sandbox egress proxy route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects requests that fail proxy OIDC validation", async () => {
    const response = await sandboxEgressRoute({
      req: new Request(
        `https://eve.example/eve/v1/sandbox/egress/r0-0/eve-sandbox/${DEMAND_TOKEN}`,
      ),
    });
    expect(response.status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects routes that do not identify the originating sandbox", async () => {
    const response = await sandboxEgressRoute({
      req: new Request("https://eve.example/eve/v1/sandbox/egress/r0-0"),
    });
    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects routes without a well-formed demand token", async () => {
    const response = await sandboxEgressRoute({
      req: new Request("https://eve.example/eve/v1/sandbox/egress/r0-0/eve-sandbox/not-a-token", {
        headers: { "vercel-sandbox-oidc-token": "signed" },
      }),
    });
    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("writes the demand token as marker content and returns 428", async () => {
    const response = await sandboxEgressRoute({
      req: new Request(
        `https://eve.example/eve/v1/sandbox/egress/r2-1/eve-sandbox%3Aname/${DEMAND_TOKEN}/get`,
        {
          headers: { "vercel-sandbox-oidc-token": "signed" },
        },
      ),
    });

    expect(response.status).toBe(428);
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ name: "eve-sandbox:name" }));
    expect(writeFiles).toHaveBeenCalledWith([
      {
        content: new TextEncoder().encode(DEMAND_TOKEN),
        path: "/tmp/eve-egress-demand/r2-1",
      },
    ]);
  });

  it("rejects a route naming a different sandbox than the OIDC source", async () => {
    get.mockResolvedValueOnce({
      currentSession: () => ({ sessionId: "different-sandbox-id" }),
      writeFiles,
    });

    const response = await sandboxEgressRoute({
      req: new Request(
        `https://eve.example/eve/v1/sandbox/egress/r2-1/other-sandbox/${DEMAND_TOKEN}/get`,
        {
          headers: { "vercel-sandbox-oidc-token": "signed" },
        },
      ),
    });

    expect(response.status).toBe(403);
    expect(writeFiles).not.toHaveBeenCalled();
  });

  it("reports the failed proxy stage without exposing the underlying error", async () => {
    get.mockRejectedValueOnce(new Error("secret provider response"));

    const response = await sandboxEgressRoute({
      req: new Request(
        `https://eve.example/eve/v1/sandbox/egress/r2-1/eve-sandbox/${DEMAND_TOKEN}/get`,
        {
          headers: { "vercel-sandbox-oidc-token": "signed" },
        },
      ),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining("the route stays closed"),
      errorId: "error-id",
      stage: "sandbox_lookup",
    });
    expect(logError).toHaveBeenCalledWith(
      expect.anything(),
      "sandbox egress proxy failed",
      expect.any(Error),
      expect.objectContaining({
        ruleId: "r2-1",
        sandboxId: "sandbox-id",
        sandboxName: "eve-sandbox",
        stage: "sandbox_lookup",
      }),
    );
  });
});
