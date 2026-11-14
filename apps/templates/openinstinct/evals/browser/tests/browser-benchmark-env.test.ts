import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("browser benchmark environment", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("BROWSER_BENCH_LABEL", undefined);
    vi.stubEnv("BROWSER_BENCH_REPETITIONS", undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("provides benchmark defaults independently of the runtime environment", async () => {
    const { browserBenchmarkEnv } = await import("../env");

    expect(browserBenchmarkEnv.BROWSER_BENCH_LABEL).toBeUndefined();
    expect(browserBenchmarkEnv.BROWSER_BENCH_REPETITIONS).toBe(1);
  });

  it("validates the repetition count", async () => {
    vi.stubEnv("BROWSER_BENCH_REPETITIONS", "21");

    await expect(import("../env")).rejects.toThrow(
      "Invalid environment variables"
    );
  });
});
