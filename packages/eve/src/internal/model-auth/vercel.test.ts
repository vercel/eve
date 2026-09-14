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
import { resolveVercelSession } from "./vercel.js";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
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
  const [url, init] = mocks.fetch.mock.calls[0]!;
  expect(url).toBe("https://vercel.com/oauth/token");
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
