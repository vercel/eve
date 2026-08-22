import { describe, expect, it, vi } from "vitest";

import type { ChannelSetupLog } from "#setup/cli/index.js";
import { parseCreatedDiscordConnector, provisionDiscordConnector } from "./connect.js";

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

describe("Discord Connect provisioning", () => {
  it("parses an app-scoped Discord connector", () => {
    expect(
      parseCreatedDiscordConnector(
        JSON.stringify({
          id: "scl_discord",
          uid: "discord/agent",
          supportedSubjectTypes: ["app"],
        }),
      ),
    ).toEqual({ id: "scl_discord", uid: "discord/agent" });
  });

  it("creates the connector with stdin credentials and replaces its trigger", async () => {
    const runVercelCaptureStdout = vi.fn(async () => ({
      ok: true as const,
      stdout: JSON.stringify({
        id: "scl_discord",
        uid: "discord/agent",
        supportedSubjectTypes: ["app"],
      }),
      stderr: "",
    }));
    const runVercel = vi.fn(async () => true);

    await expect(
      provisionDiscordConnector({
        botToken: "bot-token",
        log: log(),
        project: { orgId: "team_123", projectId: "prj_123" },
        projectRoot: "/project",
        slug: "agent",
        deps: { runVercel, runVercelCaptureStdout },
      }),
    ).resolves.toEqual({ id: "scl_discord", uid: "discord/agent" });

    expect(runVercelCaptureStdout).toHaveBeenCalledWith(
      [
        "connect",
        "create",
        "discord",
        "--connector-type",
        "discord",
        "--data",
        "@-",
        "--name",
        "agent",
        "--triggers",
        "-F",
        "json",
        "--scope",
        "team_123",
      ],
      expect.objectContaining({
        cwd: "/project",
        nonInteractive: true,
        stdin: JSON.stringify({ botToken: "bot-token" }),
      }),
    );
    expect(runVercel).toHaveBeenNthCalledWith(
      2,
      [
        "connect",
        "attach",
        "discord/agent",
        "--project",
        "prj_123",
        "--environment",
        "production",
        "--triggers",
        "--trigger-path",
        "/eve/v1/discord",
        "--yes",
        "--scope",
        "team_123",
      ],
      expect.objectContaining({ cwd: "/project", nonInteractive: true }),
    );
  });
});
