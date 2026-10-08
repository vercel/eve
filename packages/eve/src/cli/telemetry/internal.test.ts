import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isEphemeralEveTelemetryEnvironment } from "#cli/telemetry/identity.js";
import { resolveEveTelemetryInternal } from "#cli/telemetry/internal.js";
import {
  readEveTelemetryInternalTeam,
  writeEveTelemetryInternalTeam,
} from "#cli/telemetry/preference.js";
import { readVercelCliTeam, readVercelCliToken } from "#internal/model-auth/vercel-cli.js";

vi.mock("#cli/telemetry/identity.js", () => ({
  isEphemeralEveTelemetryEnvironment: vi.fn(() => false),
}));
vi.mock("#cli/telemetry/preference.js", () => ({
  readEveTelemetryInternalTeam: vi.fn(async () => undefined),
  writeEveTelemetryInternalTeam: vi.fn(async () => {}),
}));
vi.mock("#internal/model-auth/vercel-cli.js", () => ({
  readVercelCliTeam: vi.fn(async () => "team_selected"),
  readVercelCliToken: vi.fn(async () => "cli-token"),
}));

function stubTeam(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.mocked(isEphemeralEveTelemetryEnvironment).mockReturnValue(false);
  vi.mocked(readEveTelemetryInternalTeam).mockResolvedValue(undefined);
  vi.mocked(readVercelCliTeam).mockResolvedValue("team_selected");
  vi.mocked(readVercelCliToken).mockResolvedValue("cli-token");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveEveTelemetryInternal", () => {
  it("flags a selected team whose sign-up email domain is vercel.com and saves the result", async () => {
    const fetchMock = stubTeam({ id: "team_selected", emailDomain: "vercel.com" });

    await expect(resolveEveTelemetryInternal()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.vercel.com/v2/teams/team_selected",
      expect.objectContaining({ headers: { authorization: "Bearer cli-token" } }),
    );
    expect(writeEveTelemetryInternalTeam).toHaveBeenCalledWith({
      teamId: "team_selected",
      internal: true,
    });
  });

  it("reports false for another email domain or none", async () => {
    stubTeam({ id: "team_selected", emailDomain: "example.com" });
    await expect(resolveEveTelemetryInternal()).resolves.toBe(false);

    stubTeam({ id: "team_selected", emailDomain: null });
    await expect(resolveEveTelemetryInternal()).resolves.toBe(false);
  });

  it("reuses a saved result while the selected team is unchanged", async () => {
    const fetchMock = stubTeam({ emailDomain: "example.com" });
    vi.mocked(readEveTelemetryInternalTeam).mockResolvedValue({
      teamId: "team_selected",
      internal: true,
    });

    await expect(resolveEveTelemetryInternal()).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("looks the team up again when the selected team changes", async () => {
    const fetchMock = stubTeam({ emailDomain: "example.com" });
    vi.mocked(readEveTelemetryInternalTeam).mockResolvedValue({
      teamId: "team_previous",
      internal: true,
    });

    await expect(resolveEveTelemetryInternal()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(writeEveTelemetryInternalTeam).toHaveBeenCalledWith({
      teamId: "team_selected",
      internal: false,
    });
  });

  it("stays unknown without a selected team, a CLI login, or a successful lookup", async () => {
    const fetchMock = stubTeam({ error: { code: "forbidden" } }, 403);
    await expect(resolveEveTelemetryInternal()).resolves.toBeUndefined();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(resolveEveTelemetryInternal()).resolves.toBeUndefined();

    vi.mocked(readVercelCliToken).mockResolvedValue(undefined);
    await expect(resolveEveTelemetryInternal()).resolves.toBeUndefined();

    vi.mocked(readVercelCliTeam).mockResolvedValue(undefined);
    await expect(resolveEveTelemetryInternal()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(writeEveTelemetryInternalTeam).not.toHaveBeenCalled();
  });

  it("does not look anything up in CI or Docker", async () => {
    vi.mocked(isEphemeralEveTelemetryEnvironment).mockReturnValue(true);
    const fetchMock = stubTeam({ emailDomain: "vercel.com" });

    await expect(resolveEveTelemetryInternal()).resolves.toBeUndefined();
    expect(readVercelCliTeam).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
