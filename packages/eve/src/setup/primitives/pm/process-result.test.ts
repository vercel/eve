import { describe, expect, it } from "vitest";

import { createPackageProcessStdoutCollector, resultSucceeded } from "./process-result.js";

const command = { executable: "npm", args: ["install"], cwd: "/app" };

function collect(options: { maxCapturedBytes?: number } = {}) {
  return createPackageProcessStdoutCollector({ command, ...options });
}

describe("package process results", () => {
  it("preserves split UTF-8 code points", () => {
    const collector = collect();
    const encoded = Buffer.from("ready 🚀\n");

    collector.write(encoded.subarray(0, 8));
    collector.write(encoded.subarray(8));
    collector.end();

    expect(collector.result({ kind: "exit", code: 0 }).stdout).toBe("ready 🚀\n");
  });

  it("bounds captured stdout without splitting a UTF-8 code point", () => {
    const collector = collect({ maxCapturedBytes: 7 });
    collector.write(Buffer.from("ready 🚀"));
    collector.end();

    expect(collector.result({ kind: "exit", code: 0 }).stdout).toBe("ready ");
  });

  it("distinguishes every termination kind from success", () => {
    const collector = collect();
    collector.end();

    expect(resultSucceeded(collector.result({ kind: "exit", code: 0 }))).toBe(true);
    expect(resultSucceeded(collector.result({ kind: "exit", code: 1 }))).toBe(false);
    expect(resultSucceeded(collector.result({ kind: "signal", signal: "SIGTERM" }))).toBe(false);
    expect(resultSucceeded(collector.result({ kind: "aborted" }))).toBe(false);
    expect(
      resultSucceeded(
        collector.result({ kind: "spawn-error", code: "ENOENT", message: "missing" }),
      ),
    ).toBe(false);
  });
});
