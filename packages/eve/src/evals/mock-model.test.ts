import { generateText, jsonSchema, stepCountIs, streamText, tool } from "ai";
import { describe, expect, it, vi } from "vitest";

import { mockModel, type MockModelRequest } from "#evals/mock-model.js";

describe("mockModel", () => {
  it("returns a deterministic default response", async () => {
    const result = await generateText({
      model: mockModel(),
      prompt: "Hello",
    });

    expect(result.text).toBe("Mock response");
    expect(result.response.modelId).toBe("model");
    expect(result.usage.inputTokens).toBe(2);
    expect(result.usage.outputTokens).toBe(4);
  });

  it("accepts a static response and streams it", async () => {
    const result = streamText({
      model: mockModel("Always the same"),
      prompt: "Hello",
    });

    await expect(result.text).resolves.toBe("Always the same");
  });

  it("gives responders a normalized prompt and supports identity and usage overrides", async () => {
    const requests: MockModelRequest[] = [];
    const model = mockModel({
      modelId: "scripted",
      provider: "test-provider",
      respond(request) {
        requests.push(request);
        return {
          text: `${request.userMessageCount}:${request.lastUserMessage}`,
          usage: { inputTokens: 10, outputTokens: 20 },
        };
      },
    });

    const result = await generateText({
      messages: [
        { content: "First", role: "user" },
        { content: "Previous", role: "assistant" },
        { content: "Second", role: "user" },
      ],
      model,
    });

    expect(result.text).toBe("2:Second");
    expect(result.response.modelId).toBe("scripted");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(20);
    expect(requests).toEqual([
      expect.objectContaining({
        lastUserMessage: "Second",
        messages: [
          { role: "user", text: "First" },
          { role: "assistant", text: "Previous" },
          { role: "user", text: "Second" },
        ],
        userMessageCount: 2,
        userMessages: ["First", "Second"],
      }),
    ]);
  });

  it("keeps framework scaffolding out of authored user messages", async () => {
    const requests: MockModelRequest[] = [];
    const agent = '<agent status="created" name="worker" id="ag_worker:123"/>';
    const notice = [
      "[Pending approvals]",
      "The following tool calls are awaiting approval and have not executed:",
      '{"requestId":"approval-1","toolName":"gate"}',
    ].join("\n");
    const result = await generateText({
      messages: [
        { content: "Run the mixed approval flow.", role: "user" },
        { content: agent, role: "user" },
        { content: notice, role: "user" },
      ],
      model: mockModel((request) => {
        requests.push(request);
        return request.lastUserMessage ?? "missing";
      }),
    });

    expect(result.text).toBe("Run the mixed approval flow.");
    expect(requests[0]).toMatchObject({
      lastUserMessage: "Run the mixed approval flow.",
      messages: [
        { role: "user", text: "Run the mixed approval flow." },
        { role: "user", text: agent },
        { role: "user", text: notice },
      ],
      userMessageCount: 1,
      userMessages: ["Run the mixed approval flow."],
    });
  });

  it("supports deterministic tool-call loops", async () => {
    const execute = vi.fn(async ({ city }: { city: string }) => ({ city, condition: "sunny" }));
    const requests: MockModelRequest[] = [];
    const model = mockModel((request) => {
      requests.push(request);

      if (request.toolResults.length === 0) {
        return {
          toolCalls: [{ input: { city: "Brooklyn" }, name: "get_weather" }],
        };
      }

      return `Weather: ${JSON.stringify(request.toolResults[0]!.output)}`;
    });

    const result = await generateText({
      model,
      prompt: "What is the weather?",
      stopWhen: stepCountIs(2),
      tools: {
        get_weather: tool({
          description: "Get the weather for a city.",
          execute,
          inputSchema: jsonSchema({
            additionalProperties: false,
            properties: { city: { type: "string" } },
            required: ["city"],
            type: "object",
          }),
        }),
      },
    });

    expect(execute).toHaveBeenCalledExactlyOnceWith({ city: "Brooklyn" }, expect.any(Object));
    expect(result.text).toBe('Weather: {"city":"Brooklyn","condition":"sunny"}');
    expect(requests[0]!.tools).toEqual([
      expect.objectContaining({
        description: "Get the weather for a city.",
        name: "get_weather",
      }),
    ]);
    expect(requests[1]!.toolResults).toEqual([
      expect.objectContaining({
        isError: false,
        name: "get_weather",
        output: { city: "Brooklyn", condition: "sunny" },
      }),
    ]);
  });

  it("rejects empty advanced responses", async () => {
    await expect(
      generateText({
        model: mockModel(() => ({})),
        prompt: "Hello",
      }),
    ).rejects.toThrow(/must return text or at least one item/);
  });
});
