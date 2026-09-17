import { describe, expect, it, vi } from "vitest";

import type { ChannelSetupLog } from "#setup/cli/index.js";
import { parseCreatedTeamsConnector, provisionTeamsConnector } from "./connect.js";

function log(): ChannelSetupLog {
  return {
    message: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    commandOutput: vi.fn(),
  };
}

describe("Microsoft Teams Connect provisioning", () => {
  it("parses a connector created by the Vercel CLI", () => {
    expect(
      parseCreatedTeamsConnector(JSON.stringify({ id: "scl_teams", uid: "microsoft-teams/agent" })),
    ).toEqual({ id: "scl_teams", uid: "microsoft-teams/agent" });
    expect(parseCreatedTeamsConnector("invalid")).toBeUndefined();
  });

  it("delegates app creation to Connect and registers the trigger destination", async () => {
    const runVercelCaptureStdout = vi.fn(async () => ({
      ok: true as const,
      stdout: JSON.stringify({ id: "scl_teams", uid: "microsoft-teams/agent" }),
      stderr: "",
    }));
    const runVercel = vi.fn(async () => true);

    await expect(
      provisionTeamsConnector({
        name: "Agent",
        log: log(),
        project: { orgId: "team_123", projectId: "prj_123" },
        projectRoot: "/project",
        deps: { runVercel, runVercelCaptureStdout },
      }),
    ).resolves.toEqual({ id: "scl_teams", uid: "microsoft-teams/agent" });

    expect(runVercelCaptureStdout).toHaveBeenCalledWith(
      [
        "connect",
        "create",
        "microsoft-teams",
        "--name",
        "Agent",
        "-F",
        "json",
        "--scope",
        "team_123",
      ],
      expect.objectContaining({ cwd: "/project", nonInteractive: true }),
    );
    expect(runVercel).toHaveBeenCalledWith(
      [
        "connect",
        "attach",
        "microsoft-teams/agent",
        "--project",
        "prj_123",
        "--environment",
        "production",
        "--triggers",
        "--trigger-path",
        "/eve/v1/teams",
        "--yes",
        "--scope",
        "team_123",
      ],
      expect.objectContaining({ cwd: "/project", nonInteractive: true }),
    );
  });

  it("reports the recovery command when trigger registration fails", async () => {
    const runVercelCaptureStdout = vi.fn(async () => ({
      ok: true as const,
      stdout: JSON.stringify({ id: "scl_teams", uid: "microsoft-teams/agent" }),
      stderr: "",
    }));
    const runVercel = vi.fn(async () => false);

    await expect(
      provisionTeamsConnector({
        name: "Agent",
        log: log(),
        project: { orgId: "team_123", projectId: "prj_123" },
        projectRoot: "/project",
        deps: { runVercel, runVercelCaptureStdout },
      }),
    ).rejects.toThrow(
      "vercel connect attach microsoft-teams/agent --project prj_123 --environment production --triggers --trigger-path /eve/v1/teams --yes --scope team_123",
    );
  });
});
