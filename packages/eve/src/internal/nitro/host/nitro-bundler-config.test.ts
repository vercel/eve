import { describe, expect, it } from "vitest";

import { onVendoredDependencyLog } from "#internal/bundler/vendored-dependency-log.js";

import { createNitroBundlerConfig } from "./nitro-bundler-config.js";

describe("createNitroBundlerConfig", () => {
  it("filters vendored dependency warnings from hosted builds", () => {
    expect(createNitroBundlerConfig([]).onLog).toBe(onVendoredDependencyLog);
  });
});
