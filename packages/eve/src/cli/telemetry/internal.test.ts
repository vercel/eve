import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isEphemeralEveTelemetryEnvironment } from "#cli/telemetry/identity.js";
import { resolveEveTelemetryInternal } from "#cli/telemetry/internal.js";
import {
  readEveTelemetryInternalTeam,
  writeEveTelemetryInternalTeam,
} from "#cli/telemetry/preference.js";
import { readVercelCliFileConnection } from "#internal/model-auth/vercel-cli.js";

const NOW = 1_000_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

vi.mock("#cli/telemetry/identity.js", () => ({
  hashEveTelemetryProject: vi.fn(
    (identity: { projectSalt: string }, value: string) => `${identity.projectSalt}:${value}`,
  ),
  isEphemeralEveTelemetryEnvironment: vi.fn(() => false),
}));
vi.mock("#cli/telemetry/preference.js", () => ({
  readEveTelemetryInternalTeam: vi.fn(async () => undefined),
  readOrCreateEveTelemetryIdentity: vi.fn(async () => ({
    installationId: "installation_123",
    projectSalt: "salt",
  })),
  writeEveTelemetryInternalTeam: vi.fn(async () => {}),
}));
vi.mock("#internal/model-auth/vercel-cli.js", () => ({
  readVercelCliFileConnection: vi.fn(async () => ({
    token: "cli-token",
    teamId: "team_selected",
  })),
}));

function stubTeam(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.mocked(isEphemeralEveTelemetryEnvironment).mockReturnValue(false);
  vi.mocked(readEveTelemetryInternalTeam).mockResolvedValue(undefined);
  vi.mocked(readVercelCliFileConnection).mockResolvedValue({
    token: "cli-token",
    teamId: "team_selected",
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("resolveEveTelemetryInternal", () => {
  it.each(["1", "true", "TRUE"])(
    "treats EVE_TELEMETRY_INTERNAL=%s as internal without a lookup",
    async (value) => {
      vi.stubEnv("EVE_TELEMETRY_INTERNAL", value);
      vi.mocked(isEphemeralEveTelemetryEnvironment).mockReturnValue(true);
      const fetchMock = stubTeam({ emailDomain: "example.com" });

      await expect(resolveEveTelemetryInternal()).resolves.toBe(true);
      expect(readVercelCliFileConnection).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(["0", "false", "no"])(
    "does not treat EVE_TELEMETRY_INTERNAL=%s as internal",
    async (value) => {
      vi.stubEnv("EVE_TELEMETRY_INTERNAL", value);
      stubTeam({ emailDomain: "example.com" });

      await expect(resolveEveTelemetryInternal()).resolves.toBe(false);
    },
  );

  it("flags a selected team whose sign-up email domain is vercel.com and saves the result", async () => {
    const fetchMock = stubTeam({ id: "team_selected", emailDomain: "vercel.com" });

    await expect(resolveEveTelemetryInternal()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.vercel.com/v2/teams/team_selected",
      expect.objectContaining({ headers: { authorization: "Bearer cli-token" } }),
    );
    expect(writeEveTelemetryInternalTeam).toHaveBeenCalledWith({
      teamHash: "salt:team_selected",
      internal: true,
      checkedAt: NOW,
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
      teamHash: "salt:team_selected",
      internal: true,
      checkedAt: NOW - 365 * DAY_MS,
    });

    await expect(resolveEveTelemetryInternal()).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("looks the team up again when the selected team changes", async () => {
    const fetchMock = stubTeam({ emailDomain: "example.com" });
    vi.mocked(readEveTelemetryInternalTeam).mockResolvedValue({
      teamHash: "salt:team_previous",
      internal: true,
      checkedAt: NOW,
    });

    await expect(resolveEveTelemetryInternal()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(writeEveTelemetryInternalTeam).toHaveBeenCalledWith({
      teamHash: "salt:team_selected",
      internal: false,
      checkedAt: NOW,
    });
  });

  it("saves an error response so the lookup is not repeated on every command", async () => {
    stubTeam({ error: { code: "forbidden" } }, 403);

    await expect(resolveEveTelemetryInternal()).resolves.toBeUndefined();
    expect(writeEveTelemetryInternalTeam).toHaveBeenCalledWith({
      teamHash: "salt:team_selected",
      internal: undefined,
      checkedAt: NOW,
    });
  });

  it("retries a failed lookup only after a day", async () => {
    const fetchMock = stubTeam({ emailDomain: "vercel.com" });
    vi.mocked(readEveTelemetryInternalTeam).mockResolvedValue({
      teamHash: "salt:team_selected",
      internal: undefined,
      checkedAt: NOW - DAY_MS + 1,
    });
    await expect(resolveEveTelemetryInternal()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.mocked(readEveTelemetryInternalTeam).mockResolvedValue({
      teamHash: "salt:team_selected",
      internal: undefined,
      checkedAt: NOW - DAY_MS,
    });
    await expect(resolveEveTelemetryInternal()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("saves a network failure like an error response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(resolveEveTelemetryInternal()).resolves.toBeUndefined();
    expect(writeEveTelemetryInternalTeam).toHaveBeenCalledWith({
      teamHash: "salt:team_selected",
      internal: undefined,
      checkedAt: NOW,
    });
  });

  it("stays unknown for an error response with a string error", async () => {
    stubTeam({ error: "forbidden" }, 403);

    await expect(resolveEveTelemetryInternal()).resolves.toBeUndefined();
  });

  it("stays unknown without a file-stored CLI login", async () => {
    vi.mocked(readVercelCliFileConnection).mockResolvedValue(undefined);
    await expect(resolveEveTelemetryInternal()).resolves.toBeUndefined();

    expect(writeEveTelemetryInternalTeam).not.toHaveBeenCalled();
  });

  it("does not look anything up in CI or Docker", async () => {
    vi.mocked(isEphemeralEveTelemetryEnvironment).mockReturnValue(true);
    const fetchMock = stubTeam({ emailDomain: "vercel.com" });

    await expect(resolveEveTelemetryInternal()).resolves.toBeUndefined();
    expect(readVercelCliFileConnection).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
