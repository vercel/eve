import { describe, expect, it } from "vitest";

import {
  MAX_LINE_LENGTH,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  truncateHead,
  truncateTail,
} from "#execution/sandbox/truncate-output.js";

describe("truncateTail", () => {
  it("returns small text unchanged", () => {
    const result = truncateTail("line 1\nline 2\nline 3");
    expect(result.truncated).toBe(false);
    expect(result.output).toBe("line 1\nline 2\nline 3");
    expect(result.totalLines).toBe(3);
    expect(result.outputLines).toBe(3);
  });

  it("keeps the last lines when truncating by line count", () => {
    const lines = Array.from({ length: MAX_OUTPUT_LINES + 500 }, (_, i) => `line ${i + 1}`);
    const result = truncateTail(lines.join("\n"));
    expect(result.truncated).toBe(true);
    expect(result.outputLines).toBe(MAX_OUTPUT_LINES);
    // The output should contain the last lines, not the first
    expect(result.output).toContain(`line ${MAX_OUTPUT_LINES + 500}`);
    expect(result.output).not.toContain("line 1\n");
  });

  it("keeps the last lines when truncating by bytes", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `${i}: ${"x".repeat(490)}`);
    const result = truncateTail(lines.join("\n"));
    expect(result.truncated).toBe(true);
    // The output should contain the last line
    expect(result.output).toContain("199:");
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  });

  it("caps individual lines at the max line length", () => {
    const longLine = "x".repeat(MAX_LINE_LENGTH + 500);
    const result = truncateTail(`short\n${longLine}`);
    expect(result.truncated).toBe(false);
    const lines = result.output.split("\n");
    expect(lines[1]?.length).toBeLessThanOrEqual(MAX_LINE_LENGTH + 20);
    expect(lines[1]).toContain("[truncated]");
  });

  it("returns empty text unchanged", () => {
    const result = truncateTail("");
    expect(result.truncated).toBe(false);
    expect(result.output).toBe("");
    expect(result.totalLines).toBe(0);
  });
});

describe("truncateHead", () => {
  it("returns small text unchanged", () => {
    const result = truncateHead("line 1\nline 2\nline 3");
    expect(result.truncated).toBe(false);
    expect(result.output).toBe("line 1\nline 2\nline 3");
    expect(result.totalLines).toBe(3);
    expect(result.outputLines).toBe(3);
  });

  it("keeps the first lines when truncating by line count", () => {
    const lines = Array.from({ length: MAX_OUTPUT_LINES + 500 }, (_, i) => `line ${i + 1}`);
    const result = truncateHead(lines.join("\n"));
    expect(result.truncated).toBe(true);
    expect(result.outputLines).toBe(MAX_OUTPUT_LINES);
    // The output should contain the first lines, not the last
    expect(result.output).toContain("line 1\n");
    expect(result.output).not.toContain(`line ${MAX_OUTPUT_LINES + 500}`);
  });

  it("keeps the first lines when truncating by bytes", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `${i}: ${"x".repeat(490)}`);
    const result = truncateHead(lines.join("\n"));
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("0:");
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  });

  it("caps individual lines at the max line length", () => {
    const longLine = "x".repeat(MAX_LINE_LENGTH + 500);
    const result = truncateHead(`${longLine}\nshort`);
    expect(result.truncated).toBe(false);
    const lines = result.output.split("\n");
    expect(lines[0]?.length).toBeLessThanOrEqual(MAX_LINE_LENGTH + 20);
    expect(lines[0]).toContain("[truncated]");
  });
});
