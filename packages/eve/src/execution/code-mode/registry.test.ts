import { describe, expect, it } from "vitest";
import { getProgramRuntime, registerProgramRuntime } from "./registry.js";
import type { ProgramRuntime } from "./runtime.js";

describe("program runtime registry", () => {
  it("defaults to QuickJS and clearly rejects an unavailable language", () => {
    expect(getProgramRuntime("js").language).toBe("js");
    expect(() => getProgramRuntime("py")).toThrow('Code-mode language "py" is not available');
  });
  it("allows the Python runtime to register without changing the driver", () => {
    const runtime: ProgramRuntime = {
      language: "py",
      start: async () => ({ status: "completed", output: null, logs: [] }),
      resume: async () => ({ status: "completed", output: null, logs: [] }),
    };
    registerProgramRuntime(runtime);
    expect(getProgramRuntime("py")).toBe(runtime);
  });
});
