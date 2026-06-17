import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";

import {
  defineTool,
  defineDynamic,
  disableTool,
  ExperimentalWorkflow,
} from "#public/definitions/tool.js";
import { once } from "#public/tools/approval/approval-helpers.js";
import { normalizeToolDefinition } from "#internal/authored-definition/schema-backed.js";

const FAILURE_MESSAGE = "Expected the tool export to match the public eve shape.";

describe("normalizeToolDefinition", () => {
  it("returns a tool entry for a real defineTool default export", () => {
    const tool = defineTool({
      description: "Echoes the input back to the caller.",
      inputSchema: z.object({}),
      execute(input) {
        return input;
      },
    });

    const entry = normalizeToolDefinition(tool, FAILURE_MESSAGE);

    expect(entry.kind).toBe("tool");
    if (entry.kind !== "tool") {
      throw new Error("expected tool kind");
    }
    expect(entry.definition.description).toBe("Echoes the input back to the caller.");
    expect(typeof entry.definition.execute).toBe("function");
  });

  it("returns a disabled entry for a disableTool sentinel", () => {
    const sentinel = disableTool();

    const entry = normalizeToolDefinition(sentinel, FAILURE_MESSAGE);

    expect(entry).toEqual({ kind: "disabled" });
  });

  it("returns an enable-workflow entry for the ExperimentalWorkflow marker", () => {
    const entry = normalizeToolDefinition(ExperimentalWorkflow, FAILURE_MESSAGE);

    expect(entry).toEqual({ kind: "enable-workflow" });
  });

  it("rejects authored tool exports that carry an authored `name` field", () => {
    expect(() =>
      normalizeToolDefinition(
        {
          description: "Echo.",
          execute(input: unknown) {
            return input;
          },
          name: "echo",
        },
        FAILURE_MESSAGE,
      ),
    ).toThrow('Unknown key "name"');
  });

  it("throws on a value that is neither a tool definition nor a disable sentinel", () => {
    expect(() => normalizeToolDefinition({ description: 42 }, FAILURE_MESSAGE)).toThrow(
      FAILURE_MESSAGE,
    );
    expect(() => normalizeToolDefinition("not an object", FAILURE_MESSAGE)).toThrow(
      FAILURE_MESSAGE,
    );
    expect(() => normalizeToolDefinition(null, FAILURE_MESSAGE)).toThrow(FAILURE_MESSAGE);
  });

  it("accepts authored tools that declare a `toModelOutput` function", () => {
    const tool = defineTool({
      description: "Echo.",
      inputSchema: z.object({}),
      execute(input) {
        return input;
      },
      toModelOutput() {
        return { type: "text" as const, value: "ok" };
      },
    });

    expect(normalizeToolDefinition(tool, FAILURE_MESSAGE).kind).toBe("tool");
  });

  it("normalizes authored tool output schemas", () => {
    const tool = defineTool({
      description: "Summarize.",
      inputSchema: z.object({}),
      outputSchema: z.object({ summary: z.string() }),
      execute() {
        return { summary: "ok" };
      },
    });

    const entry = normalizeToolDefinition(tool, FAILURE_MESSAGE);

    expect(entry.kind).toBe("tool");
    if (entry.kind !== "tool") {
      throw new Error("expected tool kind");
    }
    expect(entry.definition.outputSchema).toMatchObject({
      properties: { summary: { type: "string" } },
      required: ["summary"],
      type: "object",
    });
  });

  it("types approval context input from the tool input schema", () => {
    const tool = defineTool({
      description: "Requires city-scoped approval.",
      inputSchema: z.object({ city: z.string() }),
      execute(input) {
        return input.city;
      },
      needsApproval(ctx) {
        const city: string | undefined = ctx.toolInput?.city;
        // @ts-expect-error approval input is schema-typed, not an open record.
        const missing = ctx.toolInput?.missing;
        void missing;
        return city !== undefined;
      },
    });

    expect(normalizeToolDefinition(tool, FAILURE_MESSAGE).kind).toBe("tool");
  });

  it("accepts generic approval helpers on schema-typed tools", () => {
    const tool = defineTool({
      description: "Uses a reusable approval helper.",
      inputSchema: z.object({ city: z.string() }),
      execute(input) {
        return input.city;
      },
      needsApproval: once(),
    });

    expect(normalizeToolDefinition(tool, FAILURE_MESSAGE).kind).toBe("tool");
  });

  it("rejects authored tools whose `toModelOutput` is not a function", () => {
    expect(() =>
      normalizeToolDefinition(
        {
          description: "Echo.",
          execute(input: unknown) {
            return input;
          },
          toModelOutput: "not a function",
        },
        FAILURE_MESSAGE,
      ),
    ).toThrow(FAILURE_MESSAGE);
  });

  it("returns a dynamic-tool entry for a defineDynamic({ events }) export with a map", () => {
    const dynamicTools = defineDynamic({
      events: {
        "session.started": async () => ({
          echo: defineTool({
            description: "Echo tool",
            inputSchema: { type: "object" as const },
            execute: (input: Record<string, unknown>) => input,
          }),
        }),
      },
    });

    const entry = normalizeToolDefinition(dynamicTools, FAILURE_MESSAGE);
    expect(entry.kind).toBe("dynamic-tool");
    if (entry.kind !== "dynamic-tool") throw new Error("expected dynamic-tool");
    expect(entry.eventNames).toEqual(["session.started"]);
  });

  it("returns a dynamic-tool entry for a defineDynamic({ events }) export with a single entry", () => {
    const dynamicTool = defineDynamic({
      events: {
        "session.started": async () =>
          defineTool({
            description: "Dynamic echo",
            inputSchema: { type: "object" as const },
            execute: (input: Record<string, unknown>) => input,
          }),
      },
    });

    const entry = normalizeToolDefinition(dynamicTool, FAILURE_MESSAGE);
    expect(entry.kind).toBe("dynamic-tool");
    if (entry.kind !== "dynamic-tool") throw new Error("expected dynamic-tool");
    expect(entry.eventNames).toEqual(["session.started"]);
  });

  it("handles defineDynamic with multiple events", () => {
    const dynamicTools = defineDynamic({
      events: {
        "session.started": async () => ({}),
        "step.started": async () => ({}),
      },
    });

    const entry = normalizeToolDefinition(dynamicTools, FAILURE_MESSAGE);
    expect(entry.kind).toBe("dynamic-tool");
    if (entry.kind !== "dynamic-tool") throw new Error("expected dynamic-tool");
    expect(entry.eventNames).toEqual(expect.arrayContaining(["session.started", "step.started"]));
  });
});
