import { afterEach, expect, it, vi } from "vitest";
import { DEVELOPMENT_WORKFLOW_SECRET_ENV } from "#internal/workflow/development-world-protocol.js";
const stored = vi.hoisted(() => new Map<string, string>());
vi.mock("#compiled/just-secrets/index.js", () => ({
  secrets: {
    get: async ({ name }: { name: string }) => stored.get(name) ?? null,
    set: async ({ name, value }: { name: string; value: string }) => {
      stored.set(name, value);
    },
  },
}));
vi.mock("#cli/dev/environment.js", () => ({ loadDevelopmentEnvironmentFiles: async () => {} }));
import { writeVercelSession } from "./store.js";
import { VERCEL_MODEL_CLIENT_ID } from "./vercel.js";
import { handleDevelopmentModelCredentialRequest } from "./development-broker-server.js";
import { readDevelopmentModelCredential } from "./development-broker-client.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  stored.clear();
});
it("shares the access token returned by OAuth without refreshing it in the runtime", async () => {
  const origin = "http://localhost:4567";
  const secret = "local-transport-secret";
  vi.stubEnv("EVE_DEV", "1");
  vi.stubEnv("EVE_DEV_CONTROL_URL", origin);
  vi.stubEnv(DEVELOPMENT_WORKFLOW_SECRET_ENV, secret);
  vi.stubEnv("EVE_MODEL_CONNECTION", "vercel");
  vi.stubEnv("EVE_MODEL_TEAM", "team_a");
  vi.stubEnv("EVE_MODEL_TEAM_NAME", "alice");
  const accessToken = "large-access-token".repeat(600);
  await writeVercelSession(
    {
      accessToken,
      refreshToken: "rotating-refresh-token",
      expiresAt: Date.now() + 3600000,
      teamId: "team_a",
      teamName: "alice",
    },
    VERCEL_MODEL_CLIENT_ID,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(url).startsWith(origin)).toBe(true);
      return (
        (await handleDevelopmentModelCredentialRequest(new Request(url, init), {
          appRoot: "/fixture",
          secret,
        })) ?? new Response(null, { status: 404 })
      );
    }),
  );
  for (let worker = 0; worker < 2; worker++) {
    expect(await readDevelopmentModelCredential("gateway")).toMatchObject({
      token: accessToken,
      teamId: "team_a",
      teamName: "alice",
    });
  }
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(stored.get("vercel")).not.toContain(accessToken);
  expect(JSON.parse(stored.get("vercel")!).refreshToken).toBe("rotating-refresh-token");
});
