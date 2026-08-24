import { describe, expect, it } from "vitest";

import {
  createCompilerErrorDiagnostic,
  createCompilerWarningDiagnostic,
  compilerDiagnosticSchema,
  compilerDiagnosticsSummarySchema,
  formatCompilerDiagnostic,
  hasCompilerErrors,
  summarizeCompilerDiagnostics,
} from "../src/shared/compiler-diagnostics.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "../src/compiler/manifest.js";

describe("compiler diagnostics", () => {
  it("creates structured error and warning diagnostics", () => {
    const errorDiagnostic = createCompilerErrorDiagnostic({
      code: "discover/test-error",
      message: "Missing instructions.md",
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
      sourcePath: "/tmp/weather-agent/agent",
    });
    const warningDiagnostic = createCompilerWarningDiagnostic({
      code: "discover/test-warning",
      message: "Ignoring unsupported context/ directory",
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
      sourcePath: "/tmp/weather-agent/agent/context",
    });

    expect(errorDiagnostic.severity).toBe("error");
    expect(warningDiagnostic.severity).toBe("warning");
  });

  it("summarizes compiler diagnostics into manifest-friendly counts", () => {
    const diagnostics = [
      createCompilerErrorDiagnostic({
        code: "discover/missing-instructions",
        message: "Missing instructions.md",
        nodeId: ROOT_COMPILED_AGENT_NODE_ID,
        sourcePath: "/tmp/weather-agent/agent",
      }),
      createCompilerWarningDiagnostic({
        code: "discover/unsupported-entry",
        message: "Ignoring unsupported context/ directory",
        nodeId: ROOT_COMPILED_AGENT_NODE_ID,
        sourcePath: "/tmp/weather-agent/agent/context",
      }),
      createCompilerWarningDiagnostic({
        code: "discover/legacy-entry",
        message: "Ignoring legacy file",
        nodeId: ROOT_COMPILED_AGENT_NODE_ID,
        sourcePath: "/tmp/weather-agent/agent/legacy.md",
      }),
    ];

    expect(summarizeCompilerDiagnostics(diagnostics)).toEqual({
      errors: 1,
      warnings: 2,
    });
    expect(hasCompilerErrors(diagnostics)).toBe(true);
  });

  it("renders filesystem and programmatic provenance through one presentation", () => {
    expect(
      formatCompilerDiagnostic(
        createCompilerErrorDiagnostic({
          code: "compile/filesystem",
          logicalPath: "channels/filesystem.ts",
          message: "Filesystem route failed.",
          nodeId: ROOT_COMPILED_AGENT_NODE_ID,
          related: [
            {
              label: "conflicting route",
              logicalPath: "channels/other.ts",
              nodeId: ROOT_COMPILED_AGENT_NODE_ID,
              sourceId: "opaque:other",
              sourcePath: "/app/agent/channels/other.ts",
            },
          ],
          sourceId: "opaque:filesystem",
          sourcePath: "/app/agent/channels/filesystem.ts",
        }),
        { bullet: true },
      ),
    ).toBe(
      [
        "- Error [compile/filesystem]: Filesystem route failed.",
        "  source: __root__ · /app/agent/channels/filesystem.ts · channels/filesystem.ts · opaque:filesystem",
        "  related (conflicting route): __root__ · /app/agent/channels/other.ts · channels/other.ts · opaque:other",
      ].join("\n"),
    );

    expect(
      formatCompilerDiagnostic(
        createCompilerWarningDiagnostic({
          code: "compile/programmatic",
          logicalPath: "channels/default.ts",
          message: "Programmatic route was shadowed.",
          nodeId: ROOT_COMPILED_AGENT_NODE_ID,
          related: [
            {
              label: "winner",
              logicalPath: "channels/app.ts",
              nodeId: ROOT_COMPILED_AGENT_NODE_ID,
              sourceId: "opaque:app",
            },
          ],
          sourceId: "opaque:framework",
        }),
      ),
    ).toContain(
      "source: __root__ · channels/default.ts · opaque:framework\n  related (winner): __root__ · channels/app.ts · opaque:app",
    );
  });

  it("accepts programmatic locators without fabricating a physical path", () => {
    expect(
      compilerDiagnosticSchema.safeParse({
        code: "compile/programmatic",
        message: "Programmatic source warning.",
        nodeId: ROOT_COMPILED_AGENT_NODE_ID,
        severity: "warning",
        sourceId: "opaque:programmatic",
      }).success,
    ).toBe(true);
  });

  it("rejects blank diagnostic identity, locator, and related labels", () => {
    const base = {
      code: "compile/test",
      message: "Test warning.",
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
      severity: "warning" as const,
      sourceId: "opaque:test",
    };

    expect(compilerDiagnosticSchema.safeParse({ ...base, code: "  " }).success).toBe(false);
    expect(compilerDiagnosticSchema.safeParse({ ...base, message: "\t" }).success).toBe(false);
    expect(compilerDiagnosticSchema.safeParse({ ...base, sourceId: "" }).success).toBe(false);
    expect(
      compilerDiagnosticSchema.safeParse({
        ...base,
        related: [{ label: " ", nodeId: ROOT_COMPILED_AGENT_NODE_ID, sourceId: "opaque:related" }],
      }).success,
    ).toBe(false);
    expect(
      compilerDiagnosticSchema.safeParse({
        ...base,
        related: [{ label: "related", nodeId: ROOT_COMPILED_AGENT_NODE_ID, sourceId: " " }],
      }).success,
    ).toBe(false);
  });

  it("requires nonnegative integer diagnostic counts", () => {
    expect(compilerDiagnosticsSummarySchema.safeParse({ errors: -1, warnings: 0 }).success).toBe(
      false,
    );
    expect(compilerDiagnosticsSummarySchema.safeParse({ errors: 0, warnings: 0.5 }).success).toBe(
      false,
    );
  });
});
