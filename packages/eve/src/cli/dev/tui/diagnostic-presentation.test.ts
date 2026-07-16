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
});
