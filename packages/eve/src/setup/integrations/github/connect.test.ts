import { describe, expect, it, vi } from "vitest";

import type { ChannelSetupLog } from "#setup/cli/index.js";
import { parseCreatedGitHubConnector, provisionGitHubConnector } from "./connect.js";

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

describe("GitHub Connect provisioning", () => {
  it("parses an app-scoped GitHub connector", () => {
    expect(
      parseCreatedGitHubConnector(
        JSON.stringify({
          id: "scl_github",
          uid: "github/agent",
          supportedSubjectTypes: ["app"],
        }),
      ),
    ).toEqual({ id: "scl_github", uid: "github/agent" });
  });

  it("creates the connector and replaces its trigger", async () => {
    const runVercelCaptureStdout = vi.fn(async () => ({
      ok: true as const,
      stdout: JSON.stringify({
        id: "scl_github",
        uid: "github/agent",
        supportedSubjectTypes: ["app"],
      }),
      stderr: "",
    }));
    const runVercel = vi.fn(async () => true);

    await expect(
      provisionGitHubConnector({
        events: ["issue_comment", "pull_request_review_comment"],
        log: log(),
        project: { orgId: "team_123", projectId: "prj_123" },
        projectRoot: "/project",
        slug: "agent",
        deps: { runVercel, runVercelCaptureStdout },
      }),
    ).resolves.toEqual({ id: "scl_github", uid: "github/agent" });

    expect(runVercelCaptureStdout).toHaveBeenCalledWith(
      [
        "connect",
        "create",
        "github",
        "--name",
        "agent",
        "--triggers",
        "--trigger-event",
        "issue_comment",
        "--trigger-event",
        "pull_request_review_comment",
        "-F",
        "json",
        "--scope",
        "team_123",
      ],
      expect.objectContaining({ cwd: "/project", nonInteractive: true }),
    );
    expect(runVercel).toHaveBeenNthCalledWith(
      1,
      ["connect", "detach", "github/agent", "--project", "prj_123", "--yes", "--scope", "team_123"],
      expect.objectContaining({ cwd: "/project", nonInteractive: true }),
    );
    expect(runVercel).toHaveBeenNthCalledWith(
      2,
      [
        "connect",
        "attach",
        "github/agent",
        "--project",
        "prj_123",
        "--environment",
        "production",
        "--triggers",
        "--trigger-path",
        "/eve/v1/github",
        "--yes",
        "--scope",
        "team_123",
      ],
      expect.objectContaining({ cwd: "/project", nonInteractive: true }),
    );
  });
});
