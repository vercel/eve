import { describe, expect, it, vi } from "vitest";

import type { ChannelSetupLog } from "#setup/cli/index.js";
import {
  findLinearConnector,
  parseCreatedLinearConnector,
  provisionLinearConnector,
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

describe("Linear Connect provisioning", () => {
  it("parses an app-scoped Linear connector", () => {
    expect(
      parseCreatedLinearConnector(
        JSON.stringify({
          id: "scl_linear",
          uid: "linear/agent",
          supportedSubjectTypes: ["app"],
        }),
      ),
    ).toEqual({ id: "scl_linear", uid: "linear/agent" });
  });

  it("finds an existing Linear connector", async () => {
    const runVercelCaptureStdout = vi.fn(async () => ({
      ok: true as const,
      stdout: JSON.stringify({
        connectors: [
          { id: "scl_other", uid: "linear/other" },
          { id: "scl_agent", uid: "linear/agent" },
        ],
      }),
      stderr: "",
    }));

    await expect(
      findLinearConnector({
        project: { orgId: "team_123", projectId: "prj_123" },
        projectRoot: "/project",
        slug: "agent",
        deps: { runVercel: vi.fn(), runVercelCaptureStdout },
      }),
    ).resolves.toEqual({ id: "scl_agent", uid: "linear/agent" });
  });

  it("creates the connector and replaces its trigger", async () => {
    const runVercelCaptureStdout = vi.fn(async () => ({
      ok: true as const,
      stdout: JSON.stringify({
        id: "scl_linear",
        uid: "linear/agent",
        supportedSubjectTypes: ["app"],
      }),
      stderr: "",
    }));
    const runVercel = vi.fn(async () => true);

    await expect(
      provisionLinearConnector({
        log: log(),
        project: { orgId: "team_123", projectId: "prj_123" },
        projectRoot: "/project",
        slug: "agent",
        deps: { runVercel, runVercelCaptureStdout },
      }),
    ).resolves.toEqual({ id: "scl_linear", uid: "linear/agent" });

    expect(runVercelCaptureStdout).toHaveBeenCalledWith(
      [
        "connect",
        "create",
        "linear",
        "--name",
        "agent",
        "--triggers",
        "--trigger-event",
        "AgentSessionEvent",
        "-F",
        "json",
        "--scope",
        "team_123",
      ],
      expect.objectContaining({ cwd: "/project", nonInteractive: true }),
    );
    expect(runVercel).toHaveBeenNthCalledWith(
      2,
      [
        "connect",
        "attach",
        "linear/agent",
        "--project",
        "prj_123",
        "--environment",
        "production",
        "--triggers",
        "--trigger-path",
        "/eve/v1/linear",
        "--yes",
        "--scope",
        "team_123",
      ],
      expect.objectContaining({ cwd: "/project", nonInteractive: true }),
    );
  });
});
