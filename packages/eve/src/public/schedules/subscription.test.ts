import { describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({
  provider: { kind: "platform-default" },
  defaultScheduleProvider: vi.fn(),
}));
vi.mock("#platform/schedules.js", () => ({
  defaultScheduleProvider: platform.defaultScheduleProvider.mockImplementation(
    () => platform.provider,
  ),
}));

import { defineDynamicSchedules } from "#public/schedules/subscription.js";
import { inTestApp } from "#internal/testing/test-platform.js";

const inputSchema = {
  "~standard": { validate: (value: unknown) => ({ value }), vendor: "test", version: 1 },
} as never;

describe("defineDynamicSchedules", () => {
  it("resolves the platform's schedules backend when eve first reads it, not when the module loads", () => {
    const schedules = defineDynamicSchedules({ inputSchema, run: async () => {} } as never);
    expect(platform.defaultScheduleProvider).not.toHaveBeenCalled();

    expect(inTestApp(() => schedules.provider)).toBe(platform.provider);
    expect(inTestApp(() => schedules.provider)).toBe(platform.provider);
    expect(platform.defaultScheduleProvider).toHaveBeenCalledTimes(1);
  });

  it("keeps a provider the definition names", () => {
    const provider = { kind: "authored" } as never;
    const schedules = defineDynamicSchedules({
      inputSchema,
      provider,
      run: async () => {},
    } as never);

    expect(schedules.provider).toBe(provider);
    expect(platform.defaultScheduleProvider).not.toHaveBeenCalled();
  });
});
