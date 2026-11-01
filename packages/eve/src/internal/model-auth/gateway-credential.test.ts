import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./store.js", () => ({
  readModelSecret: vi.fn(),
  modelKeySecretName: (name: string) => name,
}));
import { resolveGatewayModelCredential } from "./gateway-credential.js";
import { localGatewayModel } from "./transport.js";

const fetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("EVE_DEV", "1");
  vi.stubEnv("EVE_MODEL_CONNECTION", "");
  vi.stubEnv("AI_GATEWAY_API_KEY", "machine-key");
  vi.stubEnv("EVE_MODEL_CREDENTIAL_URL", "https://hub.example/api/model-credential");
  vi.stubEnv("EVE_MODEL_CREDENTIAL_TOKEN", "bot-token");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetch.mockReset();
});

it("takes the gateway credential from the served URL over any machine credential", async () => {
  fetch.mockResolvedValue(Response.json({ kind: "oauth", token: "owner-token", teamId: "team_1" }));
  expect(await resolveGatewayModelCredential()).toEqual({
    kind: "oauth",
    token: "owner-token",
    teamId: "team_1",
  });
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe("https://hub.example/api/model-credential");
  expect(init.headers).toEqual({ authorization: "Bearer bot-token" });
});

it("names a rejected token by its hash so the server refreshes it", async () => {
  fetch.mockResolvedValue(Response.json({ kind: "oauth", token: "fresh" }));
  await resolveGatewayModelCredential("stale");
  expect(fetch.mock.calls[0]![1].headers).toEqual({
    authorization: "Bearer bot-token",
    "x-eve-model-rejected-token-sha256": createHash("sha256").update("stale").digest("hex"),
  });
});

it("fails with the server's own error", async () => {
  fetch.mockResolvedValue(
    Response.json({ error: "the Vercel sign-in needs renewing in the app" }, { status: 401 }),
  );
  await expect(resolveGatewayModelCredential()).rejects.toThrow(
    "the Vercel sign-in needs renewing in the app",
  );
});

it("refuses a served URL without its token", async () => {
  vi.stubEnv("EVE_MODEL_CREDENTIAL_TOKEN", "");
  await expect(resolveGatewayModelCredential()).rejects.toThrow("EVE_MODEL_CREDENTIAL_TOKEN");
  expect(fetch).not.toHaveBeenCalled();
});

it("routes local models through the gateway when only the served URL is set", () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  expect(localGatewayModel("anthropic/claude-sonnet-4.5")).toBeDefined();
  vi.stubEnv("EVE_MODEL_CREDENTIAL_URL", "");
  expect(localGatewayModel("anthropic/claude-sonnet-4.5")).toBeUndefined();
});
