import { describe, expect, it, vi } from "vitest";

import type { ChannelSetupLog } from "#setup/cli/index.js";
import { parseCreatedTelegramConnector, provisionTelegramConnector } from "./connect.js";

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

const createdConnector = { id: "scl_telegram", uid: "telegram/agent" };

describe("Telegram Connect provisioning", () => {
  it("parses the created connector", () => {
    expect(parseCreatedTelegramConnector(JSON.stringify(createdConnector))).toEqual(
      createdConnector,
    );
    expect(parseCreatedTelegramConnector("not json")).toBeUndefined();
  });

  it("creates an API-key connector with triggers without exposing the token in argv", async () => {
    const runVercelCaptureStdout = vi.fn(async (_argv: string[], _options: { stdin?: string }) => ({
      ok: true as const,
      stdout: JSON.stringify(createdConnector),
      stderr: "",
    }));
    const runVercel = vi.fn(async () => true);

    await expect(
      provisionTelegramConnector({
        botToken: "123456:secret-token",
        log: log(),
        project: { orgId: "team_123", projectId: "prj_123" },
        projectRoot: "/project",
        slug: "agent",
        deps: { runVercel, runVercelCaptureStdout },
      }),
    ).resolves.toEqual(createdConnector);

    const [argv, options] = runVercelCaptureStdout.mock.calls[0]!;
    expect(argv).toEqual(
      expect.arrayContaining([
        "telegram",
        "--connection-method",
        "api-key",
        "--data",
        "@-",
        "--triggers",
      ]),
    );
    expect(argv.join(" ")).not.toContain("secret-token");
    expect(JSON.parse(options.stdin ?? "")).toEqual({ values: [{ value: "123456:secret-token" }] });
    expect(runVercel).toHaveBeenLastCalledWith(
      expect.arrayContaining(["attach", "telegram/agent", "--trigger-path", "/eve/v1/telegram"]),
      expect.anything(),
    );
  });

  it("explains how to attach the trigger when attachment fails", async () => {
    const runVercelCaptureStdout = vi.fn(async () => ({
      ok: true as const,
      stdout: JSON.stringify(createdConnector),
      stderr: "",
    }));
    const runVercel = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(
      provisionTelegramConnector({
        botToken: "123456:secret-token",
        log: log(),
        project: { orgId: "team_123", projectId: "prj_123" },
        projectRoot: "/project",
        slug: "agent",
        deps: { runVercel, runVercelCaptureStdout },
      }),
    ).rejects.toThrow("vercel connect attach telegram/agent");
  });

  it("explains how to detach and reattach when the default destination stays", async () => {
    const runVercelCaptureStdout = vi.fn(async () => ({
      ok: true as const,
      stdout: JSON.stringify(createdConnector),
      stderr: "",
    }));
    const runVercel = vi.fn(async () => false);

    const error = await provisionTelegramConnector({
      botToken: "123456:secret-token",
      log: log(),
      project: { orgId: "team_123", projectId: "prj_123" },
      projectRoot: "/project",
      slug: "agent",
      deps: { runVercel, runVercelCaptureStdout },
    }).catch((caught: unknown) => caught);

    expect(runVercel).toHaveBeenCalledTimes(1);
    expect(String(error)).toContain("vercel connect detach telegram/agent");
    expect(String(error)).toContain("vercel connect attach telegram/agent");
  });
});
