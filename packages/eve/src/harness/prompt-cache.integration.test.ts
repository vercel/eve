import { createGateway, jsonSchema } from "ai";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { PendingSkillAnnouncementKey } from "#context/dynamic-skill-lifecycle.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, StepInput, ToolLoopHarnessConfig } from "#harness/types.js";
import { attachClientContext } from "#internal/client-context.js";

interface GatewayRequest {
  prompt: Array<{ role: string; content: unknown; providerOptions?: unknown }>;
  tools: Array<{ name: string; providerOptions?: unknown }>;
  providerOptions?: { gateway?: { caching?: unknown } };
}

const marker = {
  anthropic: { cacheControl: { type: "ephemeral" } },
  bedrock: { cachePoint: { type: "default" } },
};
const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

describe("Gateway prompt cache requests", () => {
  it.each(["generate", "stream"])(
    "preserves the prefix across durable %s steps and turns",
    async (mode) => {
      const requests: GatewayRequest[] = [];
      const model = createGateway({
        apiKey: "test-key",
        fetch: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)) as GatewayRequest);
          const first = requests.length === 1;
          const content = first
            ? [{ type: "tool-call", toolCallId: "call-1", toolName: "add", input: "{}" }]
            : [{ type: "text", text: "Done." }];
          const finishReason = { unified: first ? "tool-calls" : "stop", raw: undefined };
          if (mode === "generate") {
            return Response.json({ content, finishReason, usage, warnings: [] });
          }
          const parts = [
            { type: "stream-start", warnings: [] },
            ...(first
              ? content
              : [
                  { type: "text-start", id: "answer" },
                  { type: "text-delta", id: "answer", delta: "Done." },
                  { type: "text-end", id: "answer" },
                ]),
            { type: "finish", finishReason, usage },
          ];
          return new Response(parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      })("anthropic/claude-sonnet-4.6");
      const execute = vi.fn(async () => "3");
      const config: ToolLoopHarnessConfig = {
        handleEvent: mode === "stream" ? async () => {} : undefined,
        mode: "conversation",
        resolveModel: async () => model,
        tools: new Map([
          [
            "add",
            {
              name: "add",
              description: "Add numbers",
              inputSchema: jsonSchema({ type: "object" }),
              execute,
            },
          ],
        ]),
      };
      const run = (session: HarnessSession, input?: StepInput) => {
        const ctx = new ContextContainer();
        ctx.setVirtualContext(
          PendingSkillAnnouncementKey,
          "Available skills\n- receipts: Process receipts.",
        );
        return contextStorage.run(ctx, () => createToolLoopHarness(config)(session, input));
      };
      const session: HarnessSession = {
        agent: {
          modelReference: { id: "anthropic/claude-sonnet-4.6" },
          system: "You are a test assistant.",
          tools: [{ name: "add", description: "Add numbers", inputSchema: { type: "object" } }],
        },
        compaction: { recentWindowSize: 10, threshold: 100_000 },
        continuationToken: "http:cache-test",
        history: [],
        sessionId: "cache-test",
      };

      const first = await run(
        session,
        attachClientContext({ message: "Add the selected numbers." }, ["Client context:\n1 and 2"]),
      );
      expect(typeof first.next).toBe("function");
      const second = await run(JSON.parse(JSON.stringify(first.session)));
      expect(second.next).toBeNull();
      await run(
        JSON.parse(JSON.stringify(second.session)),
        attachClientContext({ message: "Confirm." }, ["Client context:\n3 and 4"]),
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(3);

      // Cache markers advance; the content they delimit must remain identical.
      const prompts = requests.map(({ prompt }) =>
        prompt.map(({ role, content }) => ({ role, content })),
      );
      expect(prompts[1]!.slice(0, prompts[0]!.length)).toEqual(prompts[0]);
      expect(prompts[2]!.slice(0, prompts[1]!.length)).toEqual(prompts[1]);
      for (const request of requests) {
        expect(request.prompt[0]).toEqual({
          role: "system",
          content: "You are a test assistant.\n\nAvailable skills\n- receipts: Process receipts.",
          providerOptions: marker,
        });
        expect(request.prompt.at(-1)?.providerOptions).toEqual(marker);
        expect(request.tools.at(-1)?.providerOptions).toEqual(marker);
        expect(request.providerOptions?.gateway?.caching).toBeUndefined();
        expect(
          request.prompt.filter((message) =>
            JSON.stringify(message.content).includes("Client context:\\n1 and 2"),
          ),
        ).toHaveLength(1);
      }
      expect(requests[1]!.prompt.at(-1)?.role).toBe("tool");
      expect(requests[1]!.prompt.at(-2)?.providerOptions).toEqual(marker);
      expect(second.session.history).toContainEqual({
        role: "user",
        content: "Client context:\n1 and 2",
      });
    },
  );
});
