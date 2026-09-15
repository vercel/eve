import { describe, expect, it, vi } from "vitest";

import { createVercelConversationTraceReader } from "./vercel-conversation-trace-reader.js";
import { resolveSelfModificationConfig } from "./config.js";

function deployed(authorize: () => boolean | Promise<boolean> = () => true) {
  return resolveSelfModificationConfig({
    deployed: {
      authorize: () => authorize(),
      credentials: { pat: true },
      source: { git: { directory: ".", repository: "github.com/acme/agent" } },
      target: { branch: "main" },
    },
  }).deployed!;
}

function context(rootSessionId = "conversation-a") {
  return {
    session: {
      auth: { current: null, initiator: null },
      id: "selfmod-child",
      parent: {
        callId: "call",
        rootSessionId,
        sessionId: rootSessionId,
        turn: { id: "turn", sequence: 0 },
      },
      turn: { id: "child-turn", sequence: 0 },
    },
  } as never;
}

describe("Vercel conversation trace reader", () => {
  it("uses only the parent root id and rejects guessed references", async () => {
    const client = {
      getRun: vi.fn(async ({ runId }: { readonly runId: string }) => ({
        run: { id: runId, status: "completed", title: "Alice's request" },
      })),
    };
    const reader = createVercelConversationTraceReader(deployed(), client);

    await expect(reader.search(context(), {})).resolves.toMatchObject({
      conversationId: "conversation-a",
      matches: [{ traceRef: "conversation-a" }],
    });
    await expect(
      reader.inspect(context(), { limit: 10, offset: 0, traceRef: "conversation-b" }),
    ).rejects.toThrow("Conversation traces are unavailable.");
    expect(client.getRun).toHaveBeenCalledWith({ runId: "conversation-a", trace: false });
  });

  it("filters mixed records before timeline and payload aggregation", async () => {
    const client = {
      getRun: vi.fn(async () => ({
        run: { id: "conversation-a", status: "failed" },
        trace: {
          spans: [
            {
              attributes: {
                "agent.channel.audience": "public",
                "agent.run.id": "conversation-a",
                "gen_ai.tool.call.arguments": "safe argument",
                "gen_ai.tool.name": "search",
              },
              id: "span-a",
              name: "tool search",
            },
            {
              attributes: {
                "agent.run.id": "conversation-b",
                "gen_ai.tool.call.arguments": "Bob secret",
                "gen_ai.tool.name": "private",
              },
              id: "span-b",
              name: "tool private",
            },
          ],
        },
      })),
    };
    const reader = createVercelConversationTraceReader(deployed(), client);

    await expect(
      reader.inspect(context(), { limit: 10, offset: 0, traceRef: "conversation-a" }),
    ).resolves.toMatchObject({
      summary: { recordCount: 1 },
      timeline: [{ spanRef: "span-a", toolName: "search" }],
      total: 1,
    });
    const payload = await reader.inspectSpans(context(), {
      include: ["arguments"],
      spanRefs: ["span-a", "span-b"],
      traceRef: "conversation-a",
    });
    expect(payload).toMatchObject({
      spans: [
        { fields: { arguments: "safe argument" }, found: true, spanRef: "span-a" },
        { found: false, spanRef: "span-b" },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("Bob secret");
  });

  it("does not disclose payloads from a narrower trace audience", async () => {
    const reader = createVercelConversationTraceReader(deployed(), {
      getRun: async () => ({
        run: { id: "conversation-a" },
        trace: {
          spans: [
            {
              attributes: {
                "agent.channel.audience": "private",
                "agent.run.id": "conversation-a",
                "gen_ai.tool.call.result": "restricted result",
              },
              id: "span-a",
              name: "tool private",
            },
          ],
        },
      }),
    });

    const result = await reader.inspectSpans(context(), {
      include: ["result"],
      spanRefs: ["span-a"],
      traceRef: "conversation-a",
    });
    expect(result).toMatchObject({ spans: [{ availableFields: [], fields: {}, found: true }] });
    expect(JSON.stringify(result)).not.toContain("restricted result");
  });

  it("fails closed when audience markers conflict", async () => {
    const reader = createVercelConversationTraceReader(deployed(), {
      getRun: async () => ({
        run: { id: "conversation-a" },
        trace: {
          spans: [
            {
              attributes: {
                "agent.channel.audience": "private",
                "agent.run.id": "conversation-a",
                "ai.settings.context.eve.channel.audience": "public",
                "gen_ai.tool.call.arguments": "private argument",
              },
              id: "span-a",
              name: "tool private",
            },
          ],
        },
      }),
    });

    await expect(
      reader.inspectSpans(context(), {
        include: ["arguments"],
        spanRefs: ["span-a"],
        traceRef: "conversation-a",
      }),
    ).resolves.toMatchObject({
      spans: [{ availableFields: [], fields: {}, found: true, spanRef: "span-a" }],
    });
  });

  it("caps returned field payloads by UTF-8 byte length", async () => {
    const value = "€".repeat(20_000);
    const reader = createVercelConversationTraceReader(deployed(), {
      getRun: async () => ({
        run: { id: "conversation-a" },
        trace: {
          spans: [
            {
              attributes: {
                "agent.channel.audience": "public",
                "agent.run.id": "conversation-a",
                "gen_ai.tool.call.arguments": value,
                "gen_ai.tool.call.result": value,
                "error.message": value,
              },
              id: "span-a",
              name: "tool large-output",
            },
          ],
        },
      }),
    });

    const result = await reader.inspectSpans(context(), {
      include: ["arguments", "result", "error"],
      spanRefs: ["span-a"],
      traceRef: "conversation-a",
    });
    const fields = (
      result as { readonly spans: readonly { readonly fields: Record<string, string> }[] }
    ).spans[0]!.fields;

    expect(
      Object.values(fields).every(
        (field) => new TextEncoder().encode(field).byteLength <= 16 * 1024,
      ),
    ).toBe(true);
    expect(new TextEncoder().encode(Object.values(fields).join("")).byteLength).toBeLessThanOrEqual(
      32 * 1024,
    );
    expect(result).toMatchObject({ truncated: true });
  });

  it("rechecks authorization on every execution", async () => {
    let allowed = true;
    const reader = createVercelConversationTraceReader(
      deployed(() => allowed),
      {
        getRun: async ({ runId }) => ({ run: { id: runId } }),
      },
    );

    await expect(reader.search(context(), {})).resolves.toBeDefined();
    allowed = false;
    await expect(reader.search(context(), {})).rejects.toThrow(
      "Conversation traces are unavailable.",
    );
  });
});
