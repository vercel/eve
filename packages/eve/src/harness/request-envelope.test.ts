import { jsonSchema, type ModelMessage, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";

import { z } from "#compiled/zod/index.js";
import { estimateRequestEnvelope } from "#harness/request-envelope.js";

const history: ModelMessage[] = [{ role: "user", content: "Continue." }];
const estimate = (tools: ToolSet, instructions = "System policy.") =>
  estimateRequestEnvelope({ history, instructions, messages: history, tools });

describe("effective request envelope", () => {
  it("includes authored Standard Schema descriptions without traversing schema internals", async () => {
    const small = await estimate({ search: { inputSchema: z.object({ query: z.string() }) } });
    const large = await estimate({
      search: {
        inputSchema: z.object({ query: z.string().describe("catalog policy ".repeat(1_000)) }),
      },
    });
    expect(large - small).toBeGreaterThan(3_000);
  });

  it("resolves lazy and asynchronous JSON schemas before estimating", async () => {
    const schema = jsonSchema(
      Promise.resolve({
        type: "object" as const,
        description: "catalog policy ".repeat(1_000),
      }),
    );
    let resolutions = 0;
    const eager = await estimate({ search: { inputSchema: schema } });
    const deferred = await estimate({
      search: {
        inputSchema: () => {
          resolutions++;
          return schema;
        },
      },
    });
    expect(deferred).toBe(eager);
    expect(deferred).toBeGreaterThan(3_000);
    expect(resolutions).toBe(1);
  });

  it("includes provider identifiers and configured arguments", async () => {
    const provider = (domain: string): ToolSet => ({
      search: {
        type: "provider",
        isProviderExecuted: true,
        id: "test.search",
        args: { domain },
        inputSchema: z.object({}),
      },
    });
    const small = await estimate(provider("example.com"));
    const large = await estimate(provider("example.com ".repeat(1_000)));
    expect(large - small).toBeGreaterThan(2_000);
  });

  it("counts only request-only additions beyond the projected history", async () => {
    const base = await estimateRequestEnvelope({
      history,
      messages: history,
      tools: {},
      instructions: "System policy.",
    });
    const repeatedHistory = [
      ...history,
      { role: "user" as const, content: "history ".repeat(1_000) },
    ];
    const stable = await estimateRequestEnvelope({
      history: repeatedHistory,
      messages: repeatedHistory,
      tools: {},
      instructions: "System policy.",
    });
    expect(stable).toBe(base);
    const withRetry = await estimateRequestEnvelope({
      history,
      messages: [...history, { role: "user", content: "Retry note ".repeat(1_000) }],
      tools: {},
      instructions: "System policy.",
    });
    expect(withRetry - base).toBeGreaterThan(2_000);
  });
});
