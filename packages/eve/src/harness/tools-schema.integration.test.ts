import { asSchema, generateText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createOpenAI } from "#compiled/@ai-sdk/openai/index.js";
import { buildToolSet } from "#harness/tools.js";
import { toInputSchema } from "#tools/schema.js";

const inputSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    customView: { type: "string", minLength: 1 },
    filters: {
      type: "object",
      properties: {
        team: { type: "string" },
        state: { type: "string" },
      },
      required: ["team"],
      additionalProperties: false,
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

interface RecordedRequest {
  readonly tools: Array<{
    readonly name: string;
    readonly strict?: boolean;
    readonly parameters: unknown;
  }>;
}

describe("tool schemas at the model provider boundary", () => {
  it.each([
    {
      name: "MCP JSON Schema",
      schema: () => toInputSchema(inputSchema),
    },
    {
      name: "authored Zod schema",
      schema: () =>
        z.object({
          query: z.string(),
          customView: z.string().min(1).optional(),
          filters: z.object({ team: z.string(), state: z.string().optional() }).optional(),
        }),
    },
  ])("preserves optional fields in $name through OpenAI Responses", async ({ schema }) => {
    const requests: RecordedRequest[] = [];
    const model = createOpenAI({
      apiKey: "test-key",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({
          id: "resp_1",
          created_at: 0,
          model: "gpt-5.4",
          status: "completed",
          output: [
            {
              type: "function_call",
              id: "fc_1",
              call_id: "call_1",
              name: "linear__list_issues",
              arguments: JSON.stringify({ query: "sandbox error" }),
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      },
    }).responses("gpt-5.4");
    const execute = vi.fn(async (_input: unknown) => ({ issues: [] }));
    const tools = buildToolSet({
      tools: new Map([
        [
          "linear__list_issues",
          {
            name: "linear__list_issues",
            description: "Search issues by query or saved custom view.",
            inputSchema: schema(),
            execute,
          },
        ],
      ]),
    });

    await generateText({
      model,
      tools,
      prompt: "Find issues about sandbox errors.",
      maxRetries: 0,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools).toEqual([
      expect.objectContaining({
        name: "linear__list_issues",
        strict: false,
        parameters: inputSchema,
      }),
    ]);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toEqual({ query: "sandbox error" });

    const validation = asSchema(tools.linear__list_issues!.inputSchema).validate!;
    for (const input of [
      {},
      { query: "sandbox error", customView: "" },
      { query: "error", filters: {} },
    ]) {
      expect(await validation(input)).toMatchObject({ success: false });
    }
  });
});
