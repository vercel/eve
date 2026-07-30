import { describe, expect, test, vi } from "vitest";

import type { ChannelSetupLog } from "#setup/cli/index.js";
import { parseCreatedPhotonConnector, provisionPhotonConnector } from "./connect.js";

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

describe("Photon Connect provisioning", () => {
  test("parses an app-scoped connector", () => {
    expect(
      parseCreatedPhotonConnector(
        JSON.stringify({
          id: "scl_photon",
          uid: "photon/imessage0",
          supportedSubjectTypes: ["app"],
        }),
      ),
    ).toEqual({ id: "scl_photon", uid: "photon/imessage0" });
  });

  test("includes Vercel stderr when connector creation fails", async () => {
    await expect(
      provisionPhotonConnector({
        credentials: { projectId: "project-id", projectSecret: "project-secret" },
        log: log(),
        project: { orgId: "team_123", projectId: "prj_123" },
        projectRoot: "/tmp/imessage0",
        slug: "imessage0",
        deps: {
          runVercel: vi.fn(),
          runVercelCaptureStdout: vi.fn(async () => ({
            ok: false,
            stdout: "",
            stderr: 'Error: A connector named "imessage0" already exists.',
          })),
        },
      }),
    ).rejects.toThrow(
      'Photon connector creation failed:\nError: A connector named "imessage0" already exists.',
    );
  });

  test("creates a native connector, detaches, then attaches the routed trigger", async () => {
    const runVercelCaptureStdout = vi.fn().mockResolvedValueOnce({
      ok: true as const,
      stdout: JSON.stringify({
        id: "scl_photon",
        uid: "photon/imessage0",
        supportedSubjectTypes: ["app"],
      }),
    });
    const runVercel = vi.fn(async () => true);

    await expect(
      provisionPhotonConnector({
        credentials: { projectId: "project-id", projectSecret: "project-secret" },
        log: log(),
        project: { orgId: "team_123", projectId: "prj_123" },
        projectRoot: "/tmp/imessage0",
        slug: "imessage0",
        deps: { runVercel, runVercelCaptureStdout },
      }),
    ).resolves.toEqual({ id: "scl_photon", uid: "photon/imessage0" });

    expect(runVercelCaptureStdout).toHaveBeenCalledWith(
      [
        "connect",
        "create",
        "photon",
        "--connector-type",
        "photon",
        "--data",
        "@-",
        "--name",
        "imessage0",
        "--triggers",
        "-F",
        "json",
        "--scope",
        "team_123",
      ],
      expect.objectContaining({
        cwd: "/tmp/imessage0",
        nonInteractive: true,
        stdin: JSON.stringify({ projectId: "project-id", projectSecret: "project-secret" }),
      }),
    );
    expect(runVercel).toHaveBeenNthCalledWith(
      1,
      [
        "connect",
        "detach",
        "photon/imessage0",
        "--project",
        "prj_123",
        "--yes",
        "--scope",
        "team_123",
      ],
      expect.objectContaining({ cwd: "/tmp/imessage0", nonInteractive: true }),
    );
    expect(runVercel).toHaveBeenNthCalledWith(
      2,
      [
        "connect",
        "attach",
        "photon/imessage0",
        "--project",
        "prj_123",
        "--environment",
        "production",
        "--triggers",
        "--trigger-path",
        "/eve/v1/photon",
        "--yes",
        "--scope",
        "team_123",
      ],
      expect.objectContaining({ cwd: "/tmp/imessage0", nonInteractive: true }),
    );
  });

  test("rejects empty connector identifiers", () => {
    expect(
      parseCreatedPhotonConnector(
        JSON.stringify({
          id: "",
          uid: "photon/imessage0",
          supportedSubjectTypes: ["app"],
        }),
      ),
    ).toBeUndefined();
  });

  test("fails closed when the default trigger destination cannot be removed", async () => {
    const runVercelCaptureStdout = vi.fn().mockResolvedValue({
      ok: true as const,
      stdout: JSON.stringify({
        id: "scl_photon",
        uid: "photon/imessage0",
        supportedSubjectTypes: ["app"],
      }),
    });
    const runVercel = vi.fn(async () => false);

    await expect(
      provisionPhotonConnector({
        credentials: { projectId: "project-id", projectSecret: "project-secret" },
        log: log(),
        project: { orgId: "team_123", projectId: "prj_123" },
        projectRoot: "/tmp/imessage0",
        slug: "imessage0",
        deps: { runVercel, runVercelCaptureStdout },
      }),
    ).rejects.toThrow("default trigger destination could not be removed");
    expect(runVercel).toHaveBeenCalledOnce();
  });
});
