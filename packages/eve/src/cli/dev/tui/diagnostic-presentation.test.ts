import { describe, expect, it } from "vitest";

import { formatStoredDiagnostic, presentDiagnostic } from "./diagnostic-presentation.js";

describe("presentDiagnostic", () => {
  it("keeps short stderr inline", () => {
    expect(presentDiagnostic("one line", ".eve/logs/dev.log")).toEqual({
      kind: "inline",
      text: "one line",
    });
  });

  it("collapses long stacks to a summary and path", () => {
    const presentation = presentDiagnostic(
      ["Error: request failed", "  at first", "  at second", "  at third", "  at fourth"].join(
        "\n",
      ),
      ".eve/logs/dev.log",
    );

    // The first line already names the error; stack frames add no headline.
    expect(presentation).toEqual({
      kind: "stored",
      summary: "Error: request failed",
      omittedLines: 4,
      path: ".eve/logs/dev.log",
    });
    if (presentation.kind === "stored") {
      expect(formatStoredDiagnostic(presentation)).toContain("details: .eve/logs/dev.log");
    }
  });

  it("surfaces the error headline of a collapsed logger dump", () => {
    const presentation = presentDiagnostic(
      [
        "[eve:harness.tool-loop] tool execution failed {",
        "  toolName: 'get_weather',",
        "  toolCallId: 'c1',",
        "  error: {",
        "    errorId: 'ab12',",
        "    message: 'fetch failed',",
        "    name: 'TypeError',",
        "    detail: 'TypeError: fetch failed'",
        "  }",
        "}",
      ].join("\n"),
      ".eve/logs/dev.log",
    );

    expect(presentation).toMatchObject({
      kind: "stored",
      summary: "[eve:harness.tool-loop] tool execution failed {",
      headline: "message: 'fetch failed',",
      omittedLines: 8,
    });
    if (presentation.kind === "stored") {
      expect(formatStoredDiagnostic(presentation)).toBe(
        [
          "[eve:harness.tool-loop] tool execution failed {",
          "message: 'fetch failed',",
          "… 8 diagnostic lines · details: .eve/logs/dev.log",
        ].join("\n"),
      );
    }
  });

  it("surfaces a stack headline buried under prose", () => {
    const presentation = presentDiagnostic(
      [
        "worker crashed while processing the queue",
        "",
        "RangeError: Maximum call stack size exceeded",
        "  at recurse (worker.ts:10)",
        "  at recurse (worker.ts:10)",
      ].join("\n"),
      ".eve/logs/dev.log",
    );

    expect(presentation).toMatchObject({
      summary: "worker crashed while processing the queue",
      headline: "RangeError: Maximum call stack size exceeded",
    });
  });
});
