import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}));

import {
  markEveTelemetryNotified,
  readEveTelemetryPreference,
  readOrCreateEveTelemetryIdentity,
  setEveTelemetryEnabled,
} from "#cli/telemetry/preference.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("eve telemetry preference", () => {
  it("defaults to enabled before a preference exists", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("missing"));

    await expect(readEveTelemetryPreference()).resolves.toEqual({ enabled: true, notified: false });
  });

  it("reads a persisted opt-out and current notice version", async () => {
    vi.mocked(readFile).mockResolvedValue(
      '{"telemetry":{"enabled":false,"noticeVersion":1,"notifiedAt":"now"}}',
    );

    await expect(readEveTelemetryPreference()).resolves.toEqual({ enabled: false, notified: true });
  });

  it("shows the versioned notice when only an older notice timestamp exists", async () => {
    vi.mocked(readFile).mockResolvedValue('{"telemetry":{"notifiedAt":"now"}}');

    await expect(readEveTelemetryPreference()).resolves.toEqual({ enabled: true, notified: false });
  });

  it("creates and persists a telemetry identity", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("missing"));

    const identity = await readOrCreateEveTelemetryIdentity();

    expect(identity.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(identity.projectSalt).toMatch(/^[0-9a-f-]{36}$/);
    expect(writeFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining(identity.installationId),
      { mode: 0o600 },
    );
    expect(writeFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining(identity.projectSalt),
      { mode: 0o600 },
    );
  });

  it("ignores a relative XDG config home", async () => {
    vi.stubEnv("XDG_CONFIG_HOME", "relative-config");
    vi.mocked(readFile).mockRejectedValue(new Error("missing"));

    await setEveTelemetryEnabled(false);

    expect(mkdir).toHaveBeenCalledWith(join(homedir(), ".config", "eve"), { recursive: true });
  });

  it("merges telemetry changes into the eve config atomically", async () => {
    vi.stubEnv("XDG_CONFIG_HOME", "/eve-config");
    vi.mocked(readFile)
      .mockResolvedValueOnce('{"other":"preserved","telemetry":{"future":"preserved"}}')
      .mockResolvedValueOnce(
        '{"other":"preserved","telemetry":{"future":"preserved","enabled":false}}',
      );

    await setEveTelemetryEnabled(false);
    await markEveTelemetryNotified();

    expect(mkdir).toHaveBeenCalledWith("/eve-config/eve", { recursive: true });
    expect(writeFile).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^\/eve-config\/eve\/config\.json\./),
      expect.stringContaining('"other": "preserved"'),
      { mode: 0o600 },
    );
    expect(writeFile).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^\/eve-config\/eve\/config\.json\./),
      expect.stringContaining('"future": "preserved"'),
      { mode: 0o600 },
    );
    expect(writeFile).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^\/eve-config\/eve\/config\.json\./),
      expect.stringContaining('"enabled": false'),
      { mode: 0o600 },
    );
    expect(writeFile).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^\/eve-config\/eve\/config\.json\./),
      expect.stringContaining('"noticeVersion": 1'),
      { mode: 0o600 },
    );
    expect(writeFile).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^\/eve-config\/eve\/config\.json\./),
      expect.stringContaining('"notifiedAt"'),
      { mode: 0o600 },
    );
    expect(rename).toHaveBeenCalledTimes(2);
  });
});
