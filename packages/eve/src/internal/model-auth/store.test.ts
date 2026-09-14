import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("#compiled/just-secrets/index.js", () => ({ secrets: mocks }));
import { readVercelSession, writeVercelSession, writeModelSecret } from "./store.js";
beforeEach(() => vi.resetAllMocks());
it("stores only refresh credentials, keeping large access tokens in memory", async () => {
  const session = {
    accessToken: "large-token".repeat(600),
    refreshToken: "refresh",
    expiresAt: Date.now() + 100000,
    teamId: "team_a",
    teamName: "Alice",
  };
  await writeVercelSession(session);
  const stored = mocks.set.mock.calls[0]![0];
  expect(stored.service).toBe("eve");
  expect(stored.value).not.toContain(session.accessToken);
  expect(stored.value).not.toContain("accessToken");
  mocks.get.mockResolvedValue(stored.value);
  expect(await readVercelSession()).toEqual(session);
});
it("invalidates an access token after another process rotates the refresh credential", async () => {
  mocks.get.mockResolvedValue(
    JSON.stringify({ refreshToken: "rotated", teamId: "team_a", teamName: "Alice" }),
  );
  expect(await readVercelSession()).toMatchObject({ accessToken: "", expiresAt: 0 });
});
it("does not leak credential values when secure storage fails", async () => {
  mocks.set.mockRejectedValue(new Error("secret-value"));
  await expect(writeModelSecret("openai-key", "secret-value")).rejects.toThrow(
    "Cannot save to the OS secret store",
  );
});
