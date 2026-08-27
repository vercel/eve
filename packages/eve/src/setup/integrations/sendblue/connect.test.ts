import { describe, expect, test, vi } from "vitest";

import type { ChannelSetupLog } from "#setup/cli/index.js";
import { parseCreatedSendblueConnector, provisionSendblueConnector } from "./connect.js";

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

const created = { id: "scl_sendblue", uid: "sendblue/agent" };

describe("Sendblue Connect provisioning", () => {
  test("parses a managed app-scoped connector", () => {
    expect(
      parseCreatedSendblueConnector(JSON.stringify({ ...created, supportedSubjectTypes: ["app"] })),
    ).toEqual(created);
  });

  test("creates a managed account and routes its trigger", async () => {
    const runVercelCaptureStdout = vi.fn().mockResolvedValue({
      ok: true as const,
      stdout: JSON.stringify({ ...created, supportedSubjectTypes: ["app"] }),
    });

    await expect(
      provisionSendblueConnector({
        log: log(),
        project: { orgId: "team_123", projectId: "prj_123" },
        projectRoot: "/tmp/agent",
        slug: "agent",
        deps: { runVercelCaptureStdout },
      }),
    ).resolves.toEqual(created);

    expect(runVercelCaptureStdout).toHaveBeenCalledWith(
      [
        "connect",
        "create",
        "sendblue",
        "--name",
        "agent",
        "--triggers",
        "--trigger-path",
        "/eve/v1/sendblue",
        "-F",
        "json",
        "--scope",
        "team_123",
      ],
      expect.objectContaining({ cwd: "/tmp/agent", nonInteractive: true }),
    );
  });
});
