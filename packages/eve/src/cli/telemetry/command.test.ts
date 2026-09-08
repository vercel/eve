import { afterEach, describe, expect, it, vi } from "vitest";

import {
  disableEveTelemetry,
  enableEveTelemetry,
  showEveTelemetryStatus,
} from "#cli/telemetry/command.js";
import { readEveTelemetryPreference, setEveTelemetryEnabled } from "#cli/telemetry/preference.js";

vi.mock("#cli/telemetry/preference.js", () => ({
  readEveTelemetryPreference: vi.fn(async () => ({ enabled: true, notified: false })),
  setEveTelemetryEnabled: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("eve telemetry", () => {
  it("reports the durable preference", async () => {
    vi.mocked(readEveTelemetryPreference).mockResolvedValue({ enabled: false, notified: true });
    const logger = { log: vi.fn() };

    await showEveTelemetryStatus(logger);

    expect(logger.log).toHaveBeenCalledWith("Telemetry status: Disabled");
  });

  it("updates the durable preference", async () => {
    const logger = { log: vi.fn() };

    await enableEveTelemetry(logger);
    await disableEveTelemetry(logger);

    expect(setEveTelemetryEnabled).toHaveBeenNthCalledWith(1, true);
    expect(setEveTelemetryEnabled).toHaveBeenNthCalledWith(2, false);
  });
});
