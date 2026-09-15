import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveModelTeamSlug } from "./vercel-team.js";

const mocks = vi.hoisted(() => ({ cli: vi.fn(), session: vi.fn(), json: vi.fn() }));
vi.mock("./vercel-cli.js", () => ({ readVercelCliConnection: mocks.cli }));
vi.mock("./vercel.js", () => ({ resolveVercelSession: mocks.session, authJson: mocks.json }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("EVE_MODEL_TEAM", undefined);
  mocks.cli.mockResolvedValue({ token: "cli-token", teamId: "team_cli" });
  mocks.session.mockResolvedValue({ accessToken: "oauth-token", teamId: "team_oauth" });
  mocks.json.mockResolvedValue({ id: "team_cli", name: "Acme Incorporated", slug: "acme" });
});
afterEach(() => vi.unstubAllEnvs());

describe("resolveModelTeamSlug", () => {
  it.each(["vercel", "vercel-cli"])(
    "resolves the selected project team for %s",
    async (selected) => {
      vi.stubEnv("EVE_MODEL_CONNECTION", selected);
      vi.stubEnv("EVE_MODEL_TEAM", "team_override");
      const signal = new AbortController().signal;
      expect(await resolveModelTeamSlug(signal)).toBe("acme");
      expect(mocks.json).toHaveBeenCalledWith("https://api.vercel.com/v2/teams/team_override", {
        headers: { authorization: `Bearer ${selected === "vercel" ? "oauth-token" : "cli-token"}` },
        signal,
      });
    },
  );
  it("uses the CLI's current team when no project team is selected", async () => {
    vi.stubEnv("EVE_MODEL_CONNECTION", "vercel-cli");
    await resolveModelTeamSlug();
    expect(mocks.json).toHaveBeenCalledWith(
      "https://api.vercel.com/v2/teams/team_cli",
      expect.anything(),
    );
  });
  it("does not access Vercel credentials for API key connections", async () => {
    vi.stubEnv("EVE_MODEL_CONNECTION", "openai");
    expect(await resolveModelTeamSlug()).toBeUndefined();
    expect(mocks.cli).not.toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.json).not.toHaveBeenCalled();
  });
  it("does not substitute a display name or ID for a missing slug", async () => {
    vi.stubEnv("EVE_MODEL_CONNECTION", "vercel-cli");
    mocks.json.mockResolvedValue({ id: "team_cli", name: "Acme" });
    expect(await resolveModelTeamSlug()).toBeUndefined();
  });
});
