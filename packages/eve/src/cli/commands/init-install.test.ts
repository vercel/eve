import { describe, expect, it } from "vitest";

import { createInstallDiagnostics } from "./init-install.js";

describe("install diagnostics", () => {
  it("prefers actionable output even when npm keeps emitting noise", () => {
    const diagnostics = createInstallDiagnostics();
    diagnostics.append("npm silly fetching manifest");
    diagnostics.append("npm error ERESOLVE unable to resolve dependency tree");
    for (let index = 0; index < 30; index++) diagnostics.append(`npm http fetch ${index}`);
    expect(diagnostics.result()).toEqual({
      lines: ["npm error ERESOLVE unable to resolve dependency tree"],
      truncated: false,
    });
  });

  it.each(["npm silly step", "error line"])("retains the last 20 lines of %s", (prefix) => {
    const diagnostics = createInstallDiagnostics();
    for (let index = 0; index < 25; index++) diagnostics.append(`${prefix} ${index}`);
    const { lines, truncated } = diagnostics.result();
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe(`${prefix} 5`);
    expect(lines.at(-1)).toBe(`${prefix} 24`);
    expect(truncated).toBe(true);
  });

  it("bounds oversized UTF-8 lines and includes the most recent error", () => {
    const diagnostics = createInstallDiagnostics();
    diagnostics.append("🚀".repeat(10_000));
    let result = diagnostics.result();
    expect(Buffer.byteLength(`${result.lines.join("\n")}\n`)).toBeLessThanOrEqual(16 * 1_024);
    expect(result.lines.join("")).not.toContain("�");
    diagnostics.append("Registry unavailable");
    result = diagnostics.result();
    expect(Buffer.byteLength(`${result.lines.join("\n")}\n`)).toBeLessThanOrEqual(16 * 1_024);
    expect(result.lines.at(-1)).toBe("Registry unavailable");
    expect(result.truncated).toBe(true);
  });

  it("drops blank lines and terminal control sequences from diagnostics", () => {
    const diagnostics = createInstallDiagnostics();
    diagnostics.append("  ");
    diagnostics.append("\u001B[3J\u001B[Hnpm error failed");
    expect(diagnostics.result()).toEqual({ lines: ["npm error failed"], truncated: false });
  });
});
