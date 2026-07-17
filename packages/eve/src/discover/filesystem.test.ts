import { describe, expect, it } from "vitest";

import { getSupportedModuleBaseName } from "./filesystem.js";

describe("getSupportedModuleBaseName", () => {
  it("does not discover TypeScript declaration files as authored modules", () => {
    expect(getSupportedModuleBaseName("echo.d.ts")).toBeNull();
    expect(getSupportedModuleBaseName("echo.d.mts")).toBeNull();
    expect(getSupportedModuleBaseName("echo.d.cts")).toBeNull();
  });
});
