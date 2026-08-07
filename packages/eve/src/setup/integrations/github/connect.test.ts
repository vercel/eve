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

  it("creates the connector with the eve trigger path", async () => {
    const runVercelCaptureStdout = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        stdout: JSON.stringify({
          id: "scl_github",
          uid: "github/agent",
          supportedSubjectTypes: ["app"],
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true as const,
        stdout: JSON.stringify({
          data: { appSlug: "agent" },
          id: "scl_github",
          type: "github",
          uid: "github/agent",
        }),
        stderr: "",
      });
    await expect(
      provisionGitHubConnector({
        events: ["issue_comment", "pull_request_review_comment"],
        log: log(),
        project: { orgId: "team_123", projectId: "prj_123" },
        projectRoot: "/project",
        slug: "agent",
        deps: { runVercelCaptureStdout },
      }),
    ).resolves.toEqual({ appSlug: "agent", id: "scl_github", uid: "github/agent" });

    expect(runVercelCaptureStdout).toHaveBeenCalledWith(
      [
        "connect",
        "create",
        "github",
        "--name",
        "agent",
        "--triggers",
        "--trigger-path",
        "/eve/v1/github",
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
    expect(runVercelCaptureStdout).toHaveBeenNthCalledWith(
      2,
      ["api", "/v1/connect/connectors/scl_github", "--scope", "team_123", "--raw"],
      expect.objectContaining({ cwd: "/project", nonInteractive: true }),
    );
    expect(runVercelCaptureStdout).toHaveBeenCalledTimes(2);
  });
});
