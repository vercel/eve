import { afterEach, describe, expect, it, vi } from "vitest";

import { requiredEnvironmentValue } from "../../agent/lib/linq";

afterEach(() => vi.unstubAllEnvs());

describe("Linq channel environment", () => {
  it("loads and trims channel credentials from the environment", () => {
    vi.stubEnv("LINQ_API_KEY", "  linq_test_key  ");
    expect(requiredEnvironmentValue("LINQ_API_KEY")).toBe("linq_test_key");
  });

  it("fails clearly when a channel credential is missing", () => {
    vi.stubEnv("LINQ_WEBHOOK_SECRET", "");
    expect(() => requiredEnvironmentValue("LINQ_WEBHOOK_SECRET")).toThrow(
      "LINQ_WEBHOOK_SECRET is required for the Linq channel.",
    );
  });
});
