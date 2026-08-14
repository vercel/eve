import { describe, expect, it, vi } from "vitest";

import {
  createPackageProcessOutputCollector,
  resultSucceeded,
  type ProcessOutputChunk,
} from "./process-result.js";

const command = { executable: "npm", args: ["install"], cwd: "/app" };

function collect(
  options: { maxRetainedBytes?: number; onOutput?: (chunk: ProcessOutputChunk) => void } = {},
) {
  return createPackageProcessOutputCollector({ command, ...options });
}

describe("package process results", () => {
  it("preserves split UTF-8 code points with one decoder per stream", () => {
    const collector = collect();
    const encoded = Buffer.from("ready 🚀\n");

    collector.write("stdout", encoded.subarray(0, 8));
    collector.write("stdout", encoded.subarray(8));
    collector.end();

    expect(collector.result({ kind: "exit", code: 0 }).output).toEqual([
      { emittedSequence: 0, stream: "stdout", text: "ready " },
      { emittedSequence: 1, stream: "stdout", text: "🚀\n" },
    ]);
  });

  it("streams raw output while retaining only the byte bound", () => {
    const onOutput = vi.fn();
    const collector = collect({ maxRetainedBytes: 5, onOutput });
    collector.write("stdout", Buffer.from("123456789"));
    collector.end();

    const result = collector.result({ kind: "exit", code: 0 });
    expect(result.output.map((chunk) => chunk.text).join("")).toBe("12345");
    expect(result.truncatedBytes).toBe(4);
    expect(onOutput.mock.calls.map(([chunk]) => chunk.text).join("")).toBe("123456789");
  });

  it("does not split a retained UTF-8 code point at the byte bound", () => {
    const collector = collect({ maxRetainedBytes: 7 });
    collector.write("stdout", Buffer.from("ready 🚀"));
    collector.end();

    const result = collector.result({ kind: "exit", code: 0 });
    expect(result.output.map((chunk) => chunk.text).join("")).toBe("ready ");
    expect(result.truncatedBytes).toBe(4);
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
