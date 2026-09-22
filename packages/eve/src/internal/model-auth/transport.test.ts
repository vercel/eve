import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), session: vi.fn(), cli: vi.fn(), fetch: vi.fn() }));
vi.mock("./store.js", () => ({
  readModelSecret: mocks.read,
  modelKeySecretName: (name: string) => (name === "ai-gateway-key" ? name : `${name}-key`),
}));
vi.mock("./vercel.js", () => ({
  VERCEL_TEAM_HEADER: "x-vercel-ai-gateway-team",
  resolveVercelSession: mocks.session,
}));
vi.mock("./vercel-cli.js", () => ({ readVercelCliConnection: mocks.cli }));
import { createDirectModelFetch, localGatewayModel, resolveModelApiKey } from "./transport.js";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mocks.fetch.mockResolvedValue(new Response("{}")));
  vi.stubEnv("EVE_DEV", "1");
  vi.stubEnv("EVE_MODEL_KEY_SOURCE", undefined);
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  mocks.read.mockResolvedValue("stored-secret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("model credentials", () => {
  it.each(["openai", "anthropic"] as const)(
    "injects %s credentials only into request headers",
    async (provider) => {
      const body = JSON.stringify({ model: "example", messages: [] });
      await createDirectModelFetch(provider)(
        provider === "openai"
          ? "https://api.openai.com/v1/responses"
          : "https://api.anthropic.com/v1/messages",
        { method: "POST", body },
      );
      const [, request] = mocks.fetch.mock.calls[0]!;
      expect(request.body).toBe(body);
      expect(request.headers.get(provider === "openai" ? "authorization" : "x-api-key")).toBe(
        provider === "openai" ? "Bearer stored-secret" : "stored-secret",
      );
      expect(body).not.toContain("stored-secret");
    },
  );
  it("uses explicit server keys without reading the machine secret store", async () => {
    vi.stubEnv("EVE_DEV", "");
    vi.stubEnv("OPENAI_API_KEY", "server-key");
    expect(await resolveModelApiKey("openai")).toBe("server-key");
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("never falls back to machine credentials in production", async () => {
    vi.stubEnv("EVE_DEV", "");
    await expect(resolveModelApiKey("anthropic")).rejects.toThrow("server environment");
    expect(mocks.read).not.toHaveBeenCalled();
    vi.stubEnv("EVE_MODEL_CONNECTION", "vercel");
    expect(localGatewayModel("openai/gpt-5.6-luna-fast")).toBeUndefined();
  });
  it("does not place a credential in a model's serializable identity", () => {
    vi.stubEnv("EVE_MODEL_CONNECTION", "vercel");
    const model = localGatewayModel("openai/gpt-5.6-luna-fast");
    expect(JSON.stringify(model)).not.toContain("stored-secret");
    expect(mocks.session).not.toHaveBeenCalled();
  });
});

it("honors a project key chosen in /login over a different shell key", async () => {
  vi.stubEnv("EVE_MODEL_CONNECTION", "openai");
  vi.stubEnv("EVE_MODEL_KEY_SOURCE", "secret");
  vi.stubEnv("OPENAI_API_KEY", "different-shell-key");
  expect(await resolveModelApiKey("openai")).toBe("stored-secret");
});
it("does not replace a missing environment connection with a stored key", async () => {
  vi.stubEnv("EVE_MODEL_CONNECTION", "openai");
  vi.stubEnv("EVE_MODEL_KEY_SOURCE", "environment");
  await expect(resolveModelApiKey("openai")).rejects.toThrow("OPENAI_API_KEY");
  expect(mocks.read).not.toHaveBeenCalled();
});
