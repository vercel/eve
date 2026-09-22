import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveTraceAnalysisSkill } from "./extension/subagents/agent/skills/trace_analysis.js";
import { resolveInspectTraceTool } from "./extension/subagents/agent/tools/inspect_trace.js";
import { resolveInspectTraceSpansTool } from "./extension/subagents/agent/tools/inspect_trace_spans.js";
import { resolveSearchTracesTool } from "./extension/subagents/agent/tools/search_traces.js";

const traceId = "1".repeat(32);
const otherTraceId = "2".repeat(32);
const spanId = "a".repeat(16);
const toolSpanId = "b".repeat(16);
const originalEveDev = process.env.EVE_DEV;

beforeEach(() => {
  process.env.EVE_DEV = "1";
});

afterEach(() => {
  if (originalEveDev === undefined) delete process.env.EVE_DEV;
  else process.env.EVE_DEV = originalEveDev;
});

function segment(
  input: {
    agentName?: string;
    conversationId?: string;
    id?: string;
    runId?: string;
    sessionId?: string;
    status?: { code: number; message?: string };
    stepInputTokens?: readonly number[];
    toolName?: string;
  } = {},
): string {
  const id = input.id ?? traceId;
  const attributes = [
    { key: "agent.name", value: { stringValue: input.agentName ?? "reviewer" } },
    input.runId === undefined
      ? { key: "agent.session.id", value: { stringValue: input.sessionId ?? "session-a" } }
      : { key: "agent.run.id", value: { stringValue: input.runId } },
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
  for (const [index, tokens] of (input.stepInputTokens ?? []).entries()) {
    spans.push({
      attributes: [{ key: "agent.usage.input_tokens", value: { intValue: tokens } }],
      endTimeUnixNano: "30000000",
      name: "agent.step",
      spanId: (index + 1).toString(16).padStart(16, "0"),
      startTimeUnixNano: "10000000",
      status: { code: 0 },
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
        if (command === "ls -1dt /traces/*") {
          return {
            exitCode: 0,
            stderr: "",
            stdout: Object.keys(contents)
              .map((id) => `/traces/${id}`)
              .join("\n"),
          };
        }
        if (command.includes("/segments")) {
          return { exitCode: 0, stderr: "", stdout: `${spanId}.otlp.json\n` };
        }
        return { exitCode: 2, stderr: "", stdout: "" };
      },
    }),
    session: { id: "root" },
  } as never;
}

describe("self-modification trace inspection tools", () => {
  it("ranks summed step usage and returns the same summary from search and paged inspection", async () => {
    const ctx = traceContext({
      [traceId]: segment({ stepInputTokens: [100, 100], toolName: "read", status: { code: 2 } }),
      [otherTraceId]: segment({ id: otherTraceId, stepInputTokens: [150] }),
    });
    const search = await resolveSearchTracesTool({ localEnabled: true })!.execute(
      { sortBy: "inputTokens", limit: 1 },
      ctx,
    );
    const inspection = await resolveInspectTraceTool({ localEnabled: true })!.execute(
      { traceId, limit: 1 },
      ctx,
    );
    if (!("matches" in search) || !("summary" in inspection)) {
      throw new Error("Expected non-streaming trace tools.");
    }
    expect(search).toMatchObject({
      matches: [{ traceId, inputTokens: 200, errorSpanCount: 1, toolNames: ["read"] }],
      truncated: true,
    });
    expect(inspection).toMatchObject({ summary: search.matches[0], hasMore: true });
    expect(inspection.summary).toEqual(search.matches[0]);
    expect(inspection).not.toHaveProperty("totals");
    expect(inspection.summary).not.toHaveProperty("failedOperations");
  });

  it("searches structural trace metadata with session, agent, tool, and failure filters", async () => {
    const ctx = {
      abortSignal: new AbortController().signal,
      getSandbox: async () => ({
        readTextFile: async ({ path }: { path: string }) =>
          path.includes(traceId)
            ? segment({
                id: traceId,
                agentName: "worker",
                runId: "target",
                toolName: "deploy",
                status: { code: 2, message: "failed" },
              })
            : segment({ id: otherTraceId, agentName: "other", runId: "other" }),
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

    const result = await resolveSearchTracesTool({ localEnabled: true })!.execute(
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
    const result = await resolveSearchTracesTool({ localEnabled: true })!.execute({}, {
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

  it("treats an empty trace mount as an empty result", async () => {
    const result = await resolveSearchTracesTool({ localEnabled: true })!.execute({}, {
      abortSignal: new AbortController().signal,
      getSandbox: async () => ({
        run: async ({ command }: { command: string }) =>
          command === "ls -1dt /traces/*"
            ? {
                exitCode: 2,
                stderr: "ls: cannot access '/traces/*': No such file or directory",
                stdout: "",
              }
            : { exitCode: 2, stderr: "", stdout: "" },
      }),
      session: { id: "root" },
    } as never);

    expect(result).toMatchObject({ coverage: { complete: true, stored: 0 }, matches: [] });
  });

  it("keeps readable matches when one trace disappears during the scan", async () => {
    const missingTraceId = "3".repeat(32);
    const result = await resolveSearchTracesTool({ localEnabled: true })!.execute({}, {
      abortSignal: new AbortController().signal,
      getSandbox: async () => ({
        readTextFile: async () => segment({ id: traceId }),
        run: async ({ command }: { command: string }) => {
          if (command === "ls -1dt /traces/*") {
            return {
              exitCode: 0,
              stderr: "",
              stdout: `/traces/${missingTraceId}\n/traces/${traceId}\n`,
            };
          }
          if (command.includes(`/traces/${missingTraceId}/segments`)) {
            return { exitCode: 2, stderr: "trace was pruned", stdout: "" };
          }
          if (command.includes("/segments")) {
            return { exitCode: 0, stderr: "", stdout: `${spanId}.otlp.json\n` };
          }
          return { exitCode: 2, stderr: "", stdout: "" };
        },
      }),
      session: { id: "root" },
    } as never);

    expect(result).toMatchObject({
      coverage: {
        complete: false,
        matched: 1,
        stored: 2,
        warning: expect.stringContaining("read"),
      },
      matches: [{ traceId }],
    });
  });

  it("resolves trace analysis only in local mode", () => {
    delete process.env.EVE_DEV;
    expect(resolveSearchTracesTool({ localEnabled: true })).toBeNull();
    expect(resolveInspectTraceTool({ localEnabled: true })).toBeNull();
    expect(resolveInspectTraceSpansTool({ localEnabled: true })).toBeNull();
    expect(resolveTraceAnalysisSkill({ localEnabled: true })).toBeNull();
  });

  it("returns a structural timeline with argument previews and available fields", async () => {
    const result = await resolveInspectTraceTool({ localEnabled: true })!.execute(
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
      summary: { modelCalls: 1, toolCalls: 1 },
    });

    const page = await resolveInspectTraceTool({ localEnabled: true })!.execute(
      { limit: 1, offset: 1, traceId },
      traceContext({ [traceId]: segment({ id: traceId, toolName: "bash" }) }),
    );
    expect(page).toMatchObject({
      hasMore: false,
      offset: 1,
      timeline: [{ category: "tool", spanId: toolSpanId }],
      total: 2,
    });
  });

  it("returns selected payloads for several spans in one call", async () => {
    const result = await resolveInspectTraceSpansTool({ localEnabled: true })!.execute(
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
      resolveInspectTraceTool({ localEnabled: true })!.execute(
        { operation: "summary", traceId },
        {} as never,
      ),
    ).rejects.toThrow();
    await expect(
      resolveInspectTraceSpansTool({ localEnabled: true })!.execute(
        { include: ["prompt"], spanIds: [spanId], traceId },
        {} as never,
      ),
    ).rejects.toThrow("include must contain arguments, result, or error.");
  });
});
