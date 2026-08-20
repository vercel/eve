import { describe, expect, it, vi } from "vitest";

import type { ChannelSetupLog } from "#setup/cli/index.js";

import { parseCreatedLinqConnector, provisionLinqConnector } from "./connect.js";

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

const createdConnector = {
  id: "scl_linq",
  uid: "linq/agent",
  supportedSubjectTypes: ["app"],
};

describe("Linq Connect provisioning", () => {
  it("parses the provisioned phone number", () => {
    expect(
      parseCreatedLinqConnector(
        JSON.stringify({ ...createdConnector, data: { phoneNumbers: ["+14155550123"] } }),
      ),
    ).toEqual({ id: "scl_linq", uid: "linq/agent", phoneNumber: "+14155550123" });
  });

  it("creates a connector for an existing Linq account without exposing its token in argv", async () => {
    const runVercelCaptureStdout = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        stdout: JSON.stringify(createdConnector),
        stderr: "",
      })
      .mockResolvedValueOnce({
        ok: true as const,
        stdout: JSON.stringify(createdConnector),
        stderr: "",
      });
    const runVercel = vi.fn(async () => true);

    await provisionLinqConnector({
      existingAccount: { apiToken: "linq-token", phoneNumbers: ["+14155550123"] },
      log: log(),
      project: { orgId: "team_123", projectId: "prj_123" },
      projectRoot: "/project",
      slug: "agent",
      deps: { runVercel, runVercelCaptureStdout },
    });

    expect(runVercelCaptureStdout).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining(["--connector-type", "linq", "--data", "@-"]),
      expect.objectContaining({
        stdin: JSON.stringify({ apiToken: "linq-token", phoneNumbers: ["+14155550123"] }),
      }),
    );
    expect(runVercelCaptureStdout.mock.calls[0]?.[0]).not.toContain("linq-token");
  });
});
