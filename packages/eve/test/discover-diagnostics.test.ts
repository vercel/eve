import { describe, expect, it } from "vitest";

import {
  createDiscoverErrorDiagnostic,
  createDiscoverWarningDiagnostic,
  hasDiscoverErrors,
  summarizeDiscoverDiagnostics,
} from "../src/discover/diagnostics.js";

describe("discovery diagnostics", () => {
  it("creates structured error and warning diagnostics", () => {
    const errorDiagnostic = createDiscoverErrorDiagnostic({
      code: "discover/test-error",
      message: "Missing instructions.md",
      sourcePath: "/tmp/weather-agent/agent",
    });
    const warningDiagnostic = createDiscoverWarningDiagnostic({
      code: "discover/test-warning",
      message: "Ignoring unsupported context/ directory",
      sourcePath: "/tmp/weather-agent/agent/context",
    });

    expect(errorDiagnostic.severity).toBe("error");
    expect(warningDiagnostic.severity).toBe("warning");
  });

  it("summarizes discovery diagnostics into manifest-friendly counts", () => {
    const diagnostics = [
      createDiscoverErrorDiagnostic({
        code: "discover/missing-instructions",
        message: "Missing instructions.md",
        sourcePath: "/tmp/weather-agent/agent",
      }),
      createDiscoverWarningDiagnostic({
        code: "discover/unsupported-entry",
        message: "Ignoring unsupported context/ directory",
        sourcePath: "/tmp/weather-agent/agent/context",
      }),
      createDiscoverWarningDiagnostic({
        code: "discover/legacy-entry",
        message: "Ignoring legacy file",
        sourcePath: "/tmp/weather-agent/agent/legacy.md",
      }),
    ];

    expect(summarizeDiscoverDiagnostics(diagnostics)).toEqual({
      errors: 1,
      warnings: 2,
    });
    expect(hasDiscoverErrors(diagnostics)).toBe(true);
  });
});
