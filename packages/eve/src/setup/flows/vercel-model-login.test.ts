import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
const mocks = vi.hoisted(() => ({
  json: vi.fn(),
  validate: vi.fn(),
  write: vi.fn(),
  cli: vi.fn(),
  open: vi.fn(),
}));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));
vi.mock("#internal/model-auth/vercel.js", async (original) => ({
  ...(await original<typeof import("#internal/model-auth/vercel.js")>()),
  authJson: mocks.json,
  vercelOAuthEndpoints: async () => ({
    device: "https://api.vercel.com/login/oauth/device-authorization",
    token: "https://api.vercel.com/login/oauth/token",
  }),
  validateVercelAccess: mocks.validate,
}));
vi.mock("#internal/model-auth/store.js", () => ({ writeVercelSession: mocks.write }));
vi.mock("#internal/model-auth/vercel-cli.js", () => ({ readVercelCliTeam: mocks.cli }));
vi.mock("#setup/primitives/open-url.js", () => ({ openUrl: mocks.open }));
import { loginVercelModel } from "./vercel-model-login.js";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.json
    .mockResolvedValueOnce({
      device_code: "device",
      user_code: "ABCD",
      verification_uri: "https://vercel.com/oauth/device",
      interval: 1,
      expires_in: 60,
    })
    .mockResolvedValueOnce({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
});
afterEach(() => vi.restoreAllMocks());
it("requests offline access and reuses the CLI team without a picker", async () => {
  mocks.json.mockResolvedValueOnce({
    teams: [
      { id: "team_a", name: "Alice" },
      { id: "team_b", name: "Bob" },
    ],
  });
  mocks.cli.mockResolvedValue("team_b");
  const fake = createFakePrompter();
  await loginVercelModel(fake.prompter);
  expect(mocks.json.mock.calls[0]![1].body.get("scope")).toBe("openid offline_access");
  expect(fake.selectMessages).toEqual([]);
  expect(mocks.validate).toHaveBeenCalledWith("access", "team_b", undefined);
  expect(mocks.write.mock.calls[0]![0]).toMatchObject({
    teamId: "team_b",
    teamName: "Bob",
    refreshToken: "refresh",
  });
});
it("asks for a team when the CLI selection is unavailable", async () => {
  mocks.json.mockResolvedValueOnce({
    teams: [
      { id: "team_a", name: "Alice" },
      { id: "team_b", name: "Bob" },
    ],
  });
  const fake = createFakePrompter({ single: () => "team_a" });
  await loginVercelModel(fake.prompter);
  expect(fake.selectMessages).toEqual(["Vercel team"]);
});
it("does not save a team rejected by Gateway", async () => {
  mocks.json.mockResolvedValueOnce({ teams: [{ id: "team_a", name: "Alice" }] });
  mocks.validate.mockRejectedValue(new Error("Unavailable"));
  await expect(loginVercelModel(createFakePrompter().prompter)).rejects.toThrow("Unavailable");
  expect(mocks.write).not.toHaveBeenCalled();
});

it("selects the only team without prompting", async () => {
  mocks.json.mockResolvedValueOnce({ teams: [{ id: "team_only", name: "Only team" }] });
  const fake = createFakePrompter();
  await loginVercelModel(fake.prompter);
  expect(fake.selectMessages).toEqual([]);
  expect(mocks.validate).toHaveBeenCalledWith("access", "team_only", undefined);
});
