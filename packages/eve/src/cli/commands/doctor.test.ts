import { afterEach, describe, expect, it, vi } from "vitest";

import { runDoctorCommand } from "./doctor.js";

afterEach(() => {
  process.exitCode = undefined;
});

describe("runDoctorCommand", () => {
  it("writes JSON only to the logger output and exits nonzero for failures", async () => {
    const logger = { log: vi.fn() };

    await runDoctorCommand(logger, "/path/that/does/not/exist", { json: true });

    expect(logger.log).toHaveBeenCalledOnce();
    const parsed = JSON.parse(logger.log.mock.calls[0]![0]) as {
      diagnostics: Array<{ id: string }>;
    };
    expect(parsed.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "project.discovery" })]),
    );
    expect(process.exitCode).toBe(1);
  });
});
