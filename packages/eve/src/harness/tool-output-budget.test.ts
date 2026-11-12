import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { runtimeResultCalls } from "#harness/coordination.js";
import { toolCallModelOutput } from "#harness/tool-call-io.js";
import {
  boundToolOutput,
  DEFAULT_TOOL_OUTPUT_TOKENS,
  toolOutputBudgetBytes,
} from "#harness/tool-output-budget.js";

const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const textOf = (output: { readonly value: unknown }) => output.value as string;

describe("boundToolOutput", () => {
  it("returns a result within the budget unchanged", () => {
    const output = { type: "json", value: { rows: [1, 2, 3] } } as const;

    expect(boundToolOutput(output, 1_000)).toBe(output);
  });

  it("keeps the start and end of oversized text around one notice, within the budget", () => {
    const value = `BEGIN${"x".repeat(10_000)}END`;

    const bounded = boundToolOutput({ type: "text", value }, 1_000);

    expect(bounded.type).toBe("text");
    expect(bytes(textOf(bounded))).toBeLessThanOrEqual(1_000);
    expect(textOf(bounded).startsWith("BEGIN")).toBe(true);
    expect(textOf(bounded).endsWith("END")).toBe(true);
    expect(textOf(bounded).match(/eve truncated \d+ bytes/g)).toHaveLength(1);
  });

  it("is stable: a bounded result bounds to itself", () => {
    const bounded = boundToolOutput({ type: "text", value: "y".repeat(5_000) }, 800);

    expect(boundToolOutput(bounded, 800)).toBe(bounded);
  });

  it("never splits a multi-byte character", () => {
    const value = "é😀".repeat(2_000);

    const bounded = textOf(boundToolOutput({ type: "text", value }, 1_001));

    expect(bounded).not.toContain("\uFFFD");
    expect(bytes(bounded)).toBeLessThanOrEqual(1_001);
  });

  it("keeps a failure a failure", () => {
    expect(boundToolOutput({ type: "error-text", value: "e".repeat(2_000) }, 500).type).toBe(
      "error-text",
    );
    expect(
      boundToolOutput({ type: "error-json", value: { trace: "e".repeat(2_000) } }, 500).type,
    ).toBe("error-text");
  });

  it("turns oversized JSON into truncated text", () => {
    const rows = Array.from({ length: 500 }, (_, id) => ({ id, name: `row ${id}` }));

    const bounded = boundToolOutput({ type: "json", value: rows }, 1_000);

    expect(bounded.type).toBe("text");
    expect(textOf(bounded).startsWith('[{"id":0,')).toBe(true);
    expect(textOf(bounded).endsWith('"row 499"}]')).toBe(true);
    expect(bytes(textOf(bounded))).toBeLessThanOrEqual(1_000);
  });

  it("gives a content output's text parts one window and one notice, and keeps its files", () => {
    const file = {
      type: "file",
      data: { type: "data", data: "a".repeat(4_000) },
      mediaType: "image/png",
    } as const;
    const output = {
      type: "content",
      value: [
        { type: "text", text: `first ${"1".repeat(2_000)}` },
        file,
        { type: "text", text: "2".repeat(2_000) },
        { type: "text", text: `${"3".repeat(2_000)} last` },
      ],
    } as const;

    const bounded = boundToolOutput(output, 1_000);

    expect(bounded.type).toBe("content");
    const parts = bounded.value as readonly { type: string; text?: string }[];
    expect(parts).toContain(file);
    const texts = parts.flatMap((part) => (part.text === undefined ? [] : [part.text]));
    expect(texts[0]!.startsWith("first ")).toBe(true);
    expect(texts.at(-1)!.endsWith(" last")).toBe(true);
    expect(texts.join("").match(/eve truncated \d+ bytes/g)).toHaveLength(1);
    expect(bytes(texts.join(""))).toBeLessThanOrEqual(1_000);
  });
});

describe("toolOutputBudgetBytes", () => {
  it("defaults to about 48,000 bytes, and false turns the budget off", () => {
    expect(toolOutputBudgetBytes(undefined)).toBe(DEFAULT_TOOL_OUTPUT_TOKENS * 4);
    expect(toolOutputBudgetBytes(undefined)).toBe(48_000);
    expect(toolOutputBudgetBytes(100)).toBe(400);
    expect(toolOutputBudgetBytes(false)).toBeUndefined();
  });
});

describe("where tool output becomes model text", () => {
  const tool = {
    description: "Look up records.",
    inputSchema: jsonSchema({ type: "object" }),
    name: "lookup",
  };

  it("bounds a plain string an authored tool returns", async () => {
    const output = await toolCallModelOutput(tool, "z".repeat(5_000), "call_1", 1_000);

    expect(output.type).toBe("text");
    expect(bytes(textOf(output))).toBeLessThanOrEqual(1_000);
  });

  it("bounds what an authored or connection toModelOutput projects", async () => {
    const output = await toolCallModelOutput(
      { ...tool, toModelOutput: () => ({ type: "json", value: { body: "z".repeat(5_000) } }) },
      { ignored: true },
      "call_1",
      1_000,
    );

    expect(output.type).toBe("text");
    expect(bytes(textOf(output))).toBeLessThanOrEqual(1_000);
  });

  it("leaves eve's own tools and an agent without a budget alone", async () => {
    const raw = "z".repeat(5_000);

    expect(
      await toolCallModelOutput({ ...tool, frameworkTool: true }, raw, "call_1", 1_000),
    ).toEqual({ type: "text", value: raw });
    expect(await toolCallModelOutput(tool, raw, "call_1")).toEqual({ type: "text", value: raw });
  });

  it("bounds a resumed workflow tool result for the model, leaving the raw result as it was", async () => {
    const result = {
      callId: "call-1",
      kind: "tool-result",
      output: { body: "z".repeat(5_000) },
      toolName: "lookup",
    } as const;

    const [settled] = await runtimeResultCalls([result], new Map([["lookup", tool]]), 1_000);

    expect(settled!.part.output.type).toBe("text");
    expect(bytes(textOf(settled!.part.output as { value: unknown }))).toBeLessThanOrEqual(1_000);
    expect(settled!.result).toBe(result);
    expect(result.output.body).toHaveLength(5_000);
  });
});
