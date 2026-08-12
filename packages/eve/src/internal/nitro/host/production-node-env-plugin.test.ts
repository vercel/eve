import { afterEach, describe, expect, it, vi } from "vitest";

import productionNodeEnvPlugin from "#internal/nitro/host/production-node-env-plugin.js";

describe("productionNodeEnvPlugin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults NODE_ENV to production when unset", () => {
    vi.stubEnv("NODE_ENV", undefined);
    productionNodeEnvPlugin();
    expect(process.env.NODE_ENV).toBe("production");
  });

  it("leaves an explicit NODE_ENV untouched", () => {
    vi.stubEnv("NODE_ENV", "development");
    productionNodeEnvPlugin();
    expect(process.env.NODE_ENV).toBe("development");
  });
});
