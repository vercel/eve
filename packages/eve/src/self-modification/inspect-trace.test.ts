import { describe, expect, it } from "vitest";

import inspectTrace from "./extension/tools/inspect_trace.js";
import inspectTraceSpans from "./extension/tools/inspect_trace_spans.js";
import searchTraces from "./extension/tools/search_traces.js";

const traceId = "1".repeat(32);
const otherTraceId = "2".repeat(32);
const spanId = "a".repeat(16);
const toolSpanId = "b".repeat(16);

function segment(
  input: {
    agentName?: string;
    conversationId?: string;
    id?: string;
    sessionId?: string;
    status?: { code: number; message?: string };
    toolName?: string;
  } = {},
): string {
  const id = input.id ?? traceId;
  const attributes = [
    { key: "agent.name", value: { stringValue: input.agentName ?? "reviewer" } },
    { key: "agent.session.id", value: { stringValue: input.sessionId ?? "session-a" } },
    { key: "gen_ai.conversation.id", value: { stringValue: input.conversationId ?? "root" } },
    { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
    { key: "gen_ai.request.model", value: { stringValue: "test-model" } },
  ];
  const spans: Record<string, unknown>[] = [
    {
      attributes,
      endTimeUnixNano: "20000000",
      name: "chat",
      spanId,
      startTimeUnixNano: "10000000",
      status: { code: 0 },
      traceId: id,
    },
  ];
  if (input.toolName !== undefined) {
    spans.push({
      attributes: [
        { key: "gen_ai.operation.name", value: { stringValue: "execute_tool" } },
        { key: "gen_ai.tool.name", value: { stringValue: input.toolName } },
        { key: "gen_ai.tool.call.arguments", value: { stringValue: "x".repeat(250) } },
        { key: "gen_ai.tool.call.result", value: { stringValue: "tool result" } },
      ],
      endTimeUnixNano: "30000000",
      name: `execute_tool ${input.toolName}`,
      spanId: toolSpanId,
      startTimeUnixNano: "20000000",
      status: input.status ?? { code: 0 },
      traceId: id,
    });
  }
  return JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
}

function traceContext(contents: Record<string, string>) {
  return {
    abortSignal: new AbortController().signal,
    getSandbox: async () => ({
      readTextFile: async ({ path }: { path: string }) =>
        Object.entries(contents).find(([id]) => path.includes(id))?.[1] ?? null,
      run: async ({ command }: { command: string }) => {
        if (command.includes("/segments")) {
          return { exitCode: 0, stderr: "", stdout: `${spanId}.otlp.json\n` };
        }
        return { exitCode: 2, stderr: "", stdout: "" };
      },
    }),
    session: { id: "analyzer" },
  } as never;
}

describe("selfmod trace inspection tools", () => {
  it("searches structural trace metadata with session, agent, tool, and failure filters", async () => {
    const ctx = {
      abortSignal: new AbortController().signal,
      getSandbox: async () => ({
        readTextFile: async ({ path }: { path: string }) =>
          path.includes(traceId)
            ? segment({
                id: traceId,
                agentName: "worker",
                sessionId: "target",
                toolName: "deploy",
                status: { code: 2, message: "failed" },
              })
            : segment({ id: otherTraceId, agentName: "other", sessionId: "other" }),
        run: async ({ command }: { command: string }) => {
          if (command === "ls -1dt /traces/*") {
            return {
              exitCode: 0,
              stderr: "",
              stdout: `/traces/${traceId}\n/traces/${otherTraceId}\n`,
            };
          }
          if (command.includes("/segments"))
            return { exitCode: 0, stderr: "", stdout: `${spanId}.otlp.json\n` };
          return { exitCode: 2, stderr: "", stdout: "" };
        },
      }),
      session: { id: "root" },
    } as never;

    const result = await searchTraces.execute(
      { agentName: "worker", failedOnly: true, sessionId: "target", toolName: "deploy" },
      ctx,
    );

    expect(result).toMatchObject({
      coverage: { complete: true, considered: 2, matched: 2, stored: 2 },
      matches: [{ agentNames: ["worker"], sessionIds: ["target"], toolNames: ["deploy"], traceId }],
    });
  });

  it("reports incomplete coverage without exposing unindexed trace internals", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => index.toString(16).padStart(32, "0"));
    const result = await searchTraces.execute({}, {
      abortSignal: new AbortController().signal,
      getSandbox: async () => ({
        readTextFile: async () => segment({ conversationId: "other" }),
        run: async ({ command }: { command: string }) =>
          command === "ls -1dt /traces/*"
            ? { exitCode: 0, stderr: "", stdout: ids.map((id) => `/traces/${id}`).join("\n") }
            : command.includes("/segments")
              ? { exitCode: 0, stderr: "", stdout: `${spanId}.otlp.json\n` }
              : { exitCode: 2, stderr: "", stdout: "" },
      }),
      session: { id: "root" },
    } as never);

    expect(result).toMatchObject({
      coverage: {
        complete: false,
        considered: 0,
        matched: 0,
        stored: 101,
        warning: expect.any(String),
      },
    });
    expect(JSON.stringify(result)).not.toContain("legacy");
  });

  it("returns a structural timeline with argument previews and available fields", async () => {
    const result = await inspectTrace.execute(
      { traceId, limit: 2 },
      traceContext({
        [traceId]: segment({ id: traceId, toolName: "bash" }),
      }),
    );

    expect(result).toMatchObject({
      timeline: [
        { category: "model", availableFields: [] },
        {
          argumentsPreview: "x".repeat(199) + "…",
          availableFields: ["arguments", "result"],
          category: "tool",
          spanId: toolSpanId,
        },
      ],
      totals: { modelCalls: 1, toolCalls: 1 },
    });
  });

  it("returns selected payloads for several spans in one call", async () => {
    const result = await inspectTraceSpans.execute(
      { include: ["arguments", "result"], spanIds: [toolSpanId, "c".repeat(16)], traceId },
      traceContext({ [traceId]: segment({ id: traceId, toolName: "bash" }) }),
    );

    expect(result).toEqual({
      traceId,
      truncated: false,
      spans: [
        expect.objectContaining({
          availableFields: ["arguments", "result"],
          fields: { arguments: "x".repeat(250), result: "tool result" },
          found: true,
          spanId: toolSpanId,
        }),
        { found: false, spanId: "c".repeat(16) },
      ],
    });
  });

  it("validates the focused tool inputs", async () => {
    await expect(
      inspectTrace.execute({ operation: "summary", traceId }, {} as never),
    ).rejects.toThrow();
    await expect(
      inspectTraceSpans.execute({ include: ["prompt"], spanIds: [spanId], traceId }, {} as never),
    ).rejects.toThrow("include must contain arguments, result, or error.");
  });
});
