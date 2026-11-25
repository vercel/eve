import { type JSONSchema7, jsonSchema, tool, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";

import type { HarnessModelMessage } from "#harness/messages.js";
import { loadedToolNames, withoutToolLoads } from "#shared/openai-additional-tools.js";

import { fixRequestTools, withoutUnsupportedKeywords } from "./additional-tools.js";

const parameters: JSONSchema7 = {
  type: "object",
  properties: { code: { type: "string" } },
  required: ["code"],
};

const lookup = tool({ description: "Look up stock.", inputSchema: jsonSchema(parameters) });
const price = tool({
  description: "Look up price.",
  inputSchema: jsonSchema(parameters),
  strict: false,
});

const load = (...names: string[]): HarnessModelMessage => ({
  content: "",
  providerOptions: {
    openai: { additionalTools: names.map((name) => ({ name, type: "function" })) },
  },
  role: "system",
});

const omitted = (set: ToolSet, name: string) =>
  (set[name]?.providerOptions?.openai as { omitFromRequestTools?: boolean } | undefined)
    ?.omitFromRequestTools;

describe("fixRequestTools", () => {
  it("fixes the names it first sees and loads nothing", async () => {
    const result = await fixRequestTools({ fixed: undefined, history: [], tools: { lookup } });
    expect(result.names).toEqual(["lookup"]);
    expect(result.loads).toEqual([]);
    expect(result.tools.lookup).toBe(lookup);
  });

  it("omits a tool outside the fixed names from the request and loads its definition once", async () => {
    const result = await fixRequestTools({
      fixed: ["lookup"],
      history: [],
      tools: { lookup, price },
    });
    expect(result.names).toEqual(["lookup"]);
    expect(omitted(result.tools, "price")).toBe(true);
    expect(omitted(result.tools, "lookup")).toBeUndefined();
    expect(result.loads).toEqual([
      {
        content: "",
        providerOptions: {
          openai: {
            additionalTools: [
              {
                description: "Look up price.",
                name: "price",
                parameters,
                strict: false,
                type: "function",
              },
            ],
          },
        },
        role: "system",
      },
    ]);
  });

  it("does not load a tool the history already loaded", async () => {
    const result = await fixRequestTools({
      fixed: ["lookup"],
      history: [load("price")],
      tools: { lookup, price },
    });
    expect(omitted(result.tools, "price")).toBe(true);
    expect(result.loads).toEqual([]);
  });

  it("loads a tool again once compaction has removed its load", async () => {
    const result = await fixRequestTools({
      fixed: ["lookup"],
      history: [{ content: "Summary", role: "assistant" }],
      tools: { lookup, price },
    });
    expect(result.loads).toHaveLength(1);
  });

  it("leaves a tool that is no longer offered out of the request", async () => {
    const result = await fixRequestTools({
      fixed: ["lookup", "price"],
      history: [],
      tools: { lookup },
    });
    expect(Object.keys(result.tools)).toEqual(["lookup"]);
    expect(result.names).toEqual(["lookup", "price"]);
  });

  it("keeps a provider tool in the request instead of loading it", async () => {
    const provider: ToolSet[string] = {
      args: {},
      id: "openai.web_search",
      inputSchema: jsonSchema({ type: "object" }),
      isProviderExecuted: true,
      type: "provider",
    };
    const result = await fixRequestTools({
      fixed: ["lookup"],
      history: [],
      tools: { lookup, web_search: provider },
    });
    expect(result.tools.web_search).toBe(provider);
    expect(result.loads).toEqual([]);
  });

  it("waits to load while a provider tool result is pending", async () => {
    const result = await fixRequestTools({
      fixed: ["lookup"],
      history: [
        {
          content: [
            {
              input: {},
              providerExecuted: true,
              toolCallId: "ws_1",
              toolName: "web_search",
              type: "tool-call",
            },
            { input: {}, toolCallId: "call_1", toolName: "lookup", type: "tool-call" },
          ],
          role: "assistant",
        },
        {
          content: [
            {
              output: { type: "text", value: "1" },
              toolCallId: "call_1",
              toolName: "lookup",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ],
      tools: { lookup, price },
    });
    expect(omitted(result.tools, "price")).toBe(true);
    expect(result.loads).toEqual([]);
  });
});

describe("tool loads in a history", () => {
  it("names the tools it loaded and drops the load messages", () => {
    const history: HarnessModelMessage[] = [
      { content: "Hi", kind: "user", role: "user" },
      load("price", "stock"),
      { content: "System note", role: "system" },
    ];
    expect([...loadedToolNames(history)]).toEqual(["price", "stock"]);
    expect(withoutToolLoads(history)).toEqual([history[0], history[2]]);
  });
});

describe("withoutUnsupportedKeywords", () => {
  it("strips propertyNames and lookaround patterns at every depth and keeps the rest", () => {
    const schema = {
      type: "object",
      propertyNames: { pattern: "^[a-z]+$" },
      properties: {
        propertyNames: { type: "string", pattern: "^(?!x).+$" },
        kept: { type: "string", pattern: "^[(?=]+$" },
        nested: {
          type: "array",
          items: { type: "object", propertyNames: { type: "string" }, required: ["a"] },
        },
        either: { anyOf: [{ type: "string", pattern: "(?<=a)b" }, { type: "number" }] },
      },
      $defs: { loose: { type: "object", propertyNames: { type: "string" } } },
      additionalProperties: { type: "string", pattern: "(?<!a)b" },
    };

    expect(withoutUnsupportedKeywords(schema)).toEqual({
      type: "object",
      properties: {
        propertyNames: { type: "string" },
        kept: { type: "string", pattern: "^[(?=]+$" },
        nested: { type: "array", items: { type: "object", required: ["a"] } },
        either: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
      $defs: { loose: { type: "object" } },
      additionalProperties: { type: "string" },
    });
  });

  it("is applied to a loaded tool's parameters", async () => {
    const record = tool({
      description: "Record.",
      inputSchema: jsonSchema({
        type: "object",
        properties: { byName: { type: "object", propertyNames: { enum: ["a"] } } },
      }),
    });
    const { loads } = await fixRequestTools({
      fixed: ["lookup"],
      history: [],
      tools: { lookup, record },
    });
    expect(loads[0]?.providerOptions?.openai?.additionalTools).toEqual([
      {
        description: "Record.",
        name: "record",
        parameters: { type: "object", properties: { byName: { type: "object" } } },
        type: "function",
      },
    ]);
  });
});
