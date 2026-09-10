import { describe, expect, it, vi } from "vitest";

import type { ChannelSetupLog } from "#setup/cli/index.js";
import {
  attachTeamsTrigger,
  createManagedTeamsConnector,
  parseManagedTeamsCreate,
  parseTeamsConnector,
  readTeamsConnector,
} from "./connect.js";

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
  it("parses the managed creation response and connector details", () => {
    expect(
      parseManagedTeamsCreate(
        JSON.stringify({ connectorId: "scl_teams", url: "https://login.test" }),
      ),
    ).toEqual({
      connectorId: "scl_teams",
      url: "https://login.test",
    });
    expect(
      parseTeamsConnector(
        JSON.stringify({ id: "scl_teams", type: "microsoft-teams", uid: "microsoft-teams/agent" }),
        "scl_teams",
      ),
    ).toEqual({ id: "scl_teams", uid: "microsoft-teams/agent" });
  });

  it("creates a managed bot, reads it after authorization, and attaches its trigger", async () => {
    const runVercelCaptureStdout = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        stdout: JSON.stringify({ connectorId: "scl_teams", url: "https://login.test" }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true as const,
        stdout: JSON.stringify({
          id: "scl_teams",
          type: "microsoft-teams",
          uid: "microsoft-teams/agent",
        }),
        stderr: "",
      });
    const runVercel = vi.fn(async () => true);
    const input = {
      log: log(),
      project: { orgId: "team_123", projectId: "prj_123" },
      projectRoot: "/project",
      deps: { runVercel, runVercelCaptureStdout },
    };

    const created = await createManagedTeamsConnector({
      ...input,
      name: "Agent",
      resourceGroup: "eve-bots",
      subscriptionId: "subscription-id",
    });
    const connector = await readTeamsConnector({ ...input, connectorId: created.connectorId });
    await attachTeamsTrigger({ ...input, connector });

    expect(runVercelCaptureStdout).toHaveBeenNthCalledWith(
      1,
      [
        "api",
        "/v1/connect/connectors/managed/microsoft-teams",
        "-X",
        "POST",
        "--input",
        "-",
        "--raw",
        "--scope",
        "team_123",
      ],
      expect.objectContaining({
        cwd: "/project",
        nonInteractive: true,
        stdin: JSON.stringify({
          name: "Agent",
          projectId: "prj_123",
          input: { subscriptionId: "subscription-id", resourceGroup: "eve-bots" },
        }),
      }),
    );
    expect(runVercelCaptureStdout).toHaveBeenNthCalledWith(
      2,
      ["api", "/v1/connect/connectors/scl_teams", "--scope", "team_123", "--raw"],
      expect.objectContaining({ cwd: "/project", nonInteractive: true }),
    );
    expect(runVercel).toHaveBeenNthCalledWith(
      1,
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
});
