import { describe, expect, it, vi } from "vitest";

import {
  createPackageProcessOutputCollector,
  MAX_STREAMING_SECRET_LENGTH,
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
      { emittedSequence: 0, stream: "stdout", text: "ready 🚀\n" },
    ]);
  });

  it("redacts environment secrets split across chunks before every sink", () => {
    vi.stubEnv("TEST_API_TOKEN", "secret-value-123456");
    const onOutput = vi.fn();
    const collector = collect({ onOutput });

    collector.write("stderr", Buffer.from("token=secret-value-"));
    collector.write("stderr", Buffer.from("123456\n"));
    collector.end();

    const result = collector.result({ kind: "exit", code: 1 });
    expect(result.output.map((chunk) => chunk.text).join("")).toBe("token=[REDACTED]\n");
    expect(onOutput.mock.calls.map(([chunk]) => chunk.text).join("")).toBe("token=[REDACTED]\n");
    vi.unstubAllEnvs();
  });

  it("redacts credential URLs and authorization headers", () => {
    const collector = collect();
    collector.write(
      "stderr",
      Buffer.from(
        "https://user:password@example.com\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\n",
      ),
    );
    collector.end();

    expect(collector.result({ kind: "exit", code: 1 }).output[0]?.text).toBe(
      "https://user:[REDACTED]@example.com\nAuthorization: Bearer [REDACTED]\n",
    );
  });

  it("bounds retained bytes while continuing to stream all redacted output", () => {
    const onOutput = vi.fn();
    const collector = collect({ maxRetainedBytes: 5, onOutput });
    collector.write("stdout", Buffer.from("123456789"));
    collector.end();

    const result = collector.result({ kind: "exit", code: 0 });
    expect(result.output.map((chunk) => chunk.text).join("")).toBe("12345");
    expect(result.truncatedBytes).toBe(4);
    expect(onOutput.mock.calls.map(([chunk]) => chunk.text).join("")).toBe("123456789");
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

  it("exports a finite streaming secret limit", () => {
    expect(MAX_STREAMING_SECRET_LENGTH).toBeGreaterThanOrEqual(128);
    expect(MAX_STREAMING_SECRET_LENGTH).toBeLessThanOrEqual(1024);
  });
});
