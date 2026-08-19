import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

import { canonicalCommand, createEveCliTelemetry } from "#cli/telemetry/index.js";
import {
  createEveTelemetryIdentity,
  isEphemeralEveTelemetryEnvironment,
  resolveEveTelemetryProjectId,
} from "#cli/telemetry/identity.js";
import {
  markEveTelemetryNotified,
  readEveTelemetryPreference,
  readOrCreateEveTelemetryIdentity,
} from "#cli/telemetry/preference.js";

vi.mock("#cli/telemetry/identity.js", () => ({
  createEveTelemetryIdentity: vi.fn(() => ({
    installationId: "ephemeral_installation_123",
    projectSalt: "ephemeral_project_salt_123",
  })),
  isEphemeralEveTelemetryEnvironment: vi.fn(() => false),
  resolveEveTelemetryProjectId: vi.fn(async () => "project_123"),
}));

vi.mock("#cli/telemetry/preference.js", () => ({
  markEveTelemetryNotified: vi.fn(),
  readEveTelemetryPreference: vi.fn(async () => ({ enabled: true, notified: false })),
  readOrCreateEveTelemetryIdentity: vi.fn(async () => ({
    installationId: "installation_123",
    projectSalt: "project_salt_123",
  })),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.mocked(readEveTelemetryPreference)
    .mockReset()
    .mockResolvedValue({ enabled: true, notified: false });
  vi.mocked(readOrCreateEveTelemetryIdentity)
    .mockReset()
    .mockResolvedValue({ installationId: "installation_123", projectSalt: "project_salt_123" });
  vi.mocked(createEveTelemetryIdentity).mockReset().mockReturnValue({
    installationId: "ephemeral_installation_123",
    projectSalt: "ephemeral_project_salt_123",
  });
  vi.mocked(isEphemeralEveTelemetryEnvironment).mockReset().mockReturnValue(false);
});

describe("canonicalCommand", () => {
  it("records default and nested command paths without user-supplied values", () => {
    expect(canonicalCommand([])).toBe("dev");
    expect(canonicalCommand(["dev", "https://agent.example"])).toBe("dev");
    expect(canonicalCommand(["registry", "search", "private-query"])).toBe("registry:search");
    expect(canonicalCommand(["logs"])).toBe("logs:show");
  });

  it("records supported top-level commands and buckets unknown commands", () => {
    expect(canonicalCommand(["set", "--model", "private/model"])).toBe("set");
    expect(canonicalCommand(["not-a-command", "private-argument"])).toBe("unknown");
  });
});

describe("createEveCliTelemetry", () => {
  it("does not spawn a flush process when the environment override disables telemetry", async () => {
    vi.stubEnv("EVE_TELEMETRY_DISABLED", "1");
    const telemetry = createEveCliTelemetry("1.0.0");
    telemetry.trackCommand("info");

    await telemetry.flush();

    expect(spawn).not.toHaveBeenCalled();
    expect(readEveTelemetryPreference).not.toHaveBeenCalled();
    expect(readOrCreateEveTelemetryIdentity).not.toHaveBeenCalled();
  });

  it("does not spawn a flush process when the durable preference disables telemetry", async () => {
    vi.mocked(readEveTelemetryPreference).mockResolvedValue({ enabled: false, notified: true });
    const telemetry = createEveCliTelemetry("1.0.0");
    telemetry.trackCommand("info");

    await telemetry.flush();

    expect(spawn).not.toHaveBeenCalled();
    expect(readOrCreateEveTelemetryIdentity).not.toHaveBeenCalled();
  });

  it("prints and persists the first-run notice on an interactive terminal", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const stderr = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
    const logger = { error: vi.fn() };
    try {
      await createEveCliTelemetry("1.0.0").notify(logger);
    } finally {
      if (stderr === undefined) Reflect.deleteProperty(process.stderr, "isTTY");
      else Object.defineProperty(process.stderr, "isTTY", stderr);
    }

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("eve telemetry disable"));
    expect(markEveTelemetryNotified).toHaveBeenCalled();
  });

  it("records resolved dev context without inspecting command arguments", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_TELEMETRY_DEBUG", "1");
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const telemetry = createEveCliTelemetry("1.0.0");
    telemetry.trackCommand("dev");
    telemetry.trackDevContext({ target: "remote", ui: "headless" });

    await telemetry.flush();

    const events = JSON.parse(
      String(write.mock.calls[0]?.[0]).replace("[eve telemetry] ", ""),
    ) as Array<{
      key: string;
      value: string;
    }>;
    expect(events).toContainEqual(expect.objectContaining({ key: "target", value: "remote" }));
    expect(events).toContainEqual(expect.objectContaining({ key: "ui", value: "headless" }));
    expect(events).toContainEqual(
      expect.objectContaining({ key: "installation_id", value: "installation_123" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ key: "project_id", value: "project_123" }),
    );
    expect(resolveEveTelemetryProjectId).toHaveBeenCalledWith({
      identity: { installationId: "installation_123", projectSalt: "project_salt_123" },
    });
  });

  it("skips telemetry when identity initialization fails", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(readOrCreateEveTelemetryIdentity).mockRejectedValue(new Error("read-only config"));
    const telemetry = createEveCliTelemetry("1.0.0");
    telemetry.trackCommand("info");

    await expect(telemetry.flush()).resolves.toBeUndefined();

    expect(spawn).not.toHaveBeenCalled();
  });

  it("uses an in-memory identity in an ephemeral environment", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_TELEMETRY_DEBUG", "1");
    vi.mocked(isEphemeralEveTelemetryEnvironment).mockReturnValue(true);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const telemetry = createEveCliTelemetry("1.0.0");
    telemetry.trackCommand("info");

    await telemetry.flush();

    expect(readOrCreateEveTelemetryIdentity).not.toHaveBeenCalled();
    expect(createEveTelemetryIdentity).toHaveBeenCalledOnce();
    expect(String(write.mock.calls[0]?.[0])).toContain("ephemeral_installation_123");
  });

  it("flushes an allowlisted outcome through a telemetry-disabled child process", async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as never);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_TELEMETRY_DISABLED", "");
    const telemetry = createEveCliTelemetry("1.0.0");
    telemetry.trackCommand("info");
    telemetry.trackOutcome("usage_error");

    await telemetry.flush();

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([process.argv[1], "telemetry", "flush"]),
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({ EVE_TELEMETRY_DISABLED: "1" }),
      }),
    );
    expect(child.unref).toHaveBeenCalled();
    const payload = JSON.parse(vi.mocked(spawn).mock.calls[0]![1][3]!) as {
      events: Array<{ key: string; value: string }>;
    };
    expect(payload.events).toContainEqual(
      expect.objectContaining({ key: "outcome", value: "usage_error" }),
    );
    expect(payload.events).not.toContainEqual(expect.objectContaining({ key: "error_code" }));
    expect(payload.events).not.toContainEqual(expect.objectContaining({ key: "error_status" }));
  });

  it("ignores asynchronous child-process errors", async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as never);
    vi.stubEnv("NODE_ENV", "production");
    const telemetry = createEveCliTelemetry("1.0.0");
    telemetry.trackCommand("info");

    await telemetry.flush();

    expect(() => child.emit("error", new Error("spawn failed"))).not.toThrow();
    expect(child.unref).toHaveBeenCalled();
  });
});
