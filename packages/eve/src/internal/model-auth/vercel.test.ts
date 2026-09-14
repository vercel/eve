import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("./store.js", () => ({ readVercelSession: mocks.read, writeVercelSession: mocks.write }));
vi.mock("node:fs/promises", () => ({ mkdir: mocks.mkdir, rm: mocks.rm, stat: vi.fn() }));
import { authJson, vercelOAuthEndpoints, resolveVercelSession } from "./vercel.js";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockResolvedValueOnce(
    Response.json({
      device_authorization_endpoint: "https://api.vercel.com/login/oauth/device-authorization",
      token_endpoint: "https://api.vercel.com/login/oauth/token",
    }),
  );
});
it("refreshes expired OAuth access and saves rotation before releasing the lock", async () => {
  mocks.read.mockResolvedValue({
    accessToken: "old",
    refreshToken: "refresh",
    expiresAt: 0,
    teamId: "team_a",
    teamName: "Alice",
  });
  mocks.fetch.mockResolvedValue(
    Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 }),
  );
  expect(await resolveVercelSession()).toMatchObject({
    accessToken: "new",
    refreshToken: "rotated",
    teamId: "team_a",
  });
  const [url, init] = mocks.fetch.mock.calls[1]!;
  expect(url).toBe("https://api.vercel.com/login/oauth/token");
  expect(init.body.get("refresh_token")).toBe("refresh");
  expect(mocks.write).toHaveBeenCalledOnce();
  expect(mocks.rm.mock.invocationCallOrder[0]).toBeGreaterThan(
    mocks.write.mock.invocationCallOrder[0]!,
  );
});
it("reuses a fresh token without refreshing or writing credentials", async () => {
  mocks.read.mockResolvedValue({ accessToken: "fresh", expiresAt: Date.now() + 3600000 });
  expect(await resolveVercelSession()).toMatchObject({ accessToken: "fresh" });
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("releases the lock after a failed refresh without replacing the session", async () => {
  mocks.read.mockResolvedValue({ accessToken: "old", refreshToken: "refresh", expiresAt: 0 });
  mocks.fetch.mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 400 }));
  await expect(resolveVercelSession()).rejects.toThrow("Retry /login");
  expect(mocks.write).not.toHaveBeenCalled();
  expect(mocks.rm).toHaveBeenCalledOnce();
});

afterEach(() => vi.unstubAllGlobals());

it("uses the published OAuth endpoints", async () => {
  expect(await vercelOAuthEndpoints()).toEqual({
    device: "https://api.vercel.com/login/oauth/device-authorization",
    token: "https://api.vercel.com/login/oauth/token",
  });
});
it("rejects discovery endpoints outside Vercel", async () => {
  mocks.fetch.mockReset().mockResolvedValue(
    Response.json({
      device_authorization_endpoint: "https://untrusted.example/device",
      token_endpoint: "https://api.vercel.com/login/oauth/token",
    }),
  );
  await expect(vercelOAuthEndpoints()).rejects.toThrow("unexpected OAuth endpoint");
});
it("allows bounded model catalogs larger than OAuth responses", async () => {
  const catalog = { models: [{ slug: "test", instructions: "x".repeat(300_000) }] };
  mocks.fetch.mockReset().mockImplementation(async () => Response.json(catalog));
  await expect(authJson("https://chatgpt.com/models", {}, 8 * 1024 * 1024)).resolves.toEqual(
    catalog,
  );
  await expect(authJson("https://vercel.com/token")).rejects.toThrow("too large");
});
