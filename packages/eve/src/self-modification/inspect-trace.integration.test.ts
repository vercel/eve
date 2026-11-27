import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installLocalDevCapabilityEnvironment } from "#runtime/local-dev-capability.js";
import { indexLocalTraceConversation } from "#tracing/local/trace-discovery-index.js";

import { resolveTraceAnalysisSkill } from "./extension/subagents/modify/skills/trace_analysis.js";
import { resolveInspectTraceTool } from "./extension/subagents/modify/tools/inspect_trace.js";
import { resolveInspectTraceSpansTool } from "./extension/subagents/modify/tools/inspect_trace_spans.js";
import { resolveSearchTracesTool } from "./extension/subagents/modify/tools/search_traces.js";

const traceId = "1".repeat(32);
const otherTraceId = "2".repeat(32);
const spanId = "a".repeat(16);
const toolSpanId = "b".repeat(16);
const originalEveDev = process.env.EVE_DEV;
const temporaryRoots: string[] = [];

beforeEach(() => {
  process.env.EVE_DEV = "1";
});

afterEach(async () => {
  if (originalEveDev === undefined) delete process.env.EVE_DEV;
  else process.env.EVE_DEV = originalEveDev;
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function segment(
  input: {
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

interface TraceFixtureEntry {
  readonly content?: string;
  readonly indexedConversationId?: string;
  readonly mtimeMs?: number;
}

async function withTraceStore<T>(
  traces: Readonly<Record<string, string | TraceFixtureEntry>>,
  callback: (ctx: never) => Promise<T>,
): Promise<T> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-self-mod-traces-"));
  temporaryRoots.push(appRoot);
  for (const [id, entry] of Object.entries(traces)) {
    const normalized: TraceFixtureEntry = typeof entry === "string" ? { content: entry } : entry;
    const traceDir = join(appRoot, ".eve/traces/v1", id);
    await mkdir(traceDir, { recursive: true });
    if (normalized.content !== undefined) {
      const segmentsDir = join(traceDir, "segments");
      await mkdir(segmentsDir, { recursive: true });
      await writeFile(join(segmentsDir, `${spanId}.otlp.json`), normalized.content, "utf8");
      if (normalized.mtimeMs !== undefined) {
        const at = new Date(normalized.mtimeMs);
        await utimes(segmentsDir, at, at);
      }
    }
    if (normalized.indexedConversationId !== undefined) {
      await indexLocalTraceConversation({
        conversationId: normalized.indexedConversationId,
        traceDirectory: traceDir,
      });
    }
  }

  const restore = installLocalDevCapabilityEnvironment({
    appRoot,
    serverUrl: "http://127.0.0.1:3000",
  });
  try {
    return await callback({
      abortSignal: new AbortController().signal,
      session: { id: "root" },
    } as never);
  } finally {
    restore();
  }
}

describe("self-modification trace inspection tools", () => {
  it("resolves trace analysis only in local mode on POSIX hosts", () => {
    delete process.env.EVE_DEV;
    expect(resolveSearchTracesTool({ localEnabled: true })).toBeNull();
    expect(resolveInspectTraceTool({ localEnabled: true })).toBeNull();
    expect(resolveInspectTraceSpansTool({ localEnabled: true })).toBeNull();
    expect(resolveTraceAnalysisSkill({ localEnabled: true })).toBeNull();

    process.env.EVE_DEV = "1";
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      expect(resolveSearchTracesTool({ localEnabled: true })).toBeNull();
      expect(resolveInspectTraceTool({ localEnabled: true })).toBeNull();
      expect(resolveInspectTraceSpansTool({ localEnabled: true })).toBeNull();
      expect(resolveTraceAnalysisSkill({ localEnabled: true })).toBeNull();
    } finally {
      if (originalPlatform !== undefined) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });

  describe.skipIf(process.platform === "win32")("on POSIX hosts", () => {
    it("defaults an omitted search limit", async () => {
      await withTraceStore(
        {
          [traceId]: {
            content: segment({ id: traceId, toolName: "read", status: { code: 2 } }),
            mtimeMs: 2_000,
          },
          [otherTraceId]: {
            content: segment({ id: otherTraceId }),
            mtimeMs: 1_000,
          },
        },
        async (ctx) => {
          const search = resolveSearchTracesTool({ localEnabled: true })!;
          const defaultSearch = await search.execute({}, ctx);
          const sortedSearch = await search.execute({ sortBy: "failures" }, ctx);

          expect(defaultSearch).toMatchObject({
            matches: [{ traceId }, { traceId: otherTraceId }],
          });
          expect(sortedSearch).toMatchObject({
            matches: [
              { traceId, errorSpanCount: 1 },
              { traceId: otherTraceId, errorSpanCount: 0 },
            ],
          });
        },
      );
    });

    it("ranks summed step usage and returns the same summary from search and paged inspection", async () => {
      await withTraceStore(
        {
          [traceId]: segment({
            stepInputTokens: [100, 100],
            toolName: "read",
            status: { code: 2 },
          }),
          [otherTraceId]: segment({ id: otherTraceId, stepInputTokens: [150] }),
        },
        async (ctx) => {
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
        },
      );
    });

    it("searches indexed and unindexed trace metadata within the invoking conversation", async () => {
      await withTraceStore(
        {
          [traceId]: {
            content: segment({
              id: traceId,
              runId: "target",
              toolName: "deploy",
              status: { code: 2, message: "failed" },
            }),
            indexedConversationId: "root",
            mtimeMs: 2_000,
          },
          [otherTraceId]: {
            content: segment({ id: otherTraceId, runId: "other" }),
            mtimeMs: 1_000,
          },
        },
        async (ctx) => {
          const result = await resolveSearchTracesTool({ localEnabled: true })!.execute(
            { limit: 10 },
            ctx,
          );

          expect(result).toMatchObject({
            coverage: { complete: true, considered: 2, matched: 2, stored: 2 },
            matches: [
              {
                traceId,
                errorSpanCount: 1,
                sessionIds: ["target"],
                toolNames: ["deploy"],
              },
              { traceId: otherTraceId, errorSpanCount: 0, sessionIds: ["other"], toolNames: [] },
            ],
          });
        },
      );
    });

    it("reports incomplete coverage without exposing unindexed trace internals", async () => {
      const entries = Object.fromEntries(
        Array.from({ length: 101 }, (_, index) => {
          const id = index.toString(16).padStart(32, "0");
          return [id, segment({ conversationId: "other", id })];
        }),
      );
      await withTraceStore(entries, async (ctx) => {
        const result = await resolveSearchTracesTool({ localEnabled: true })!.execute(
          { limit: 10 },
          ctx,
        );

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
    });

    it("treats a missing trace directory as an empty result", async () => {
      await withTraceStore({}, async (ctx) => {
        const result = await resolveSearchTracesTool({ localEnabled: true })!.execute(
          { limit: 10 },
          ctx,
        );

        expect(result).toMatchObject({ coverage: { complete: true, stored: 0 }, matches: [] });
      });
    });

    it("keeps readable matches when one trace lacks segments during the scan", async () => {
      const missingTraceId = "3".repeat(32);
      await withTraceStore(
        {
          [missingTraceId]: {},
          [traceId]: segment({ id: traceId }),
        },
        async (ctx) => {
          const result = await resolveSearchTracesTool({ localEnabled: true })!.execute(
            { limit: 10 },
            ctx,
          );

          expect(result).toMatchObject({
            coverage: {
              complete: false,
              matched: 1,
              stored: 2,
              warning: expect.stringContaining("read"),
            },
            matches: [{ traceId }],
          });
        },
      );
    });

    it("returns a structural timeline with argument previews and available fields", async () => {
      await withTraceStore(
        { [traceId]: segment({ id: traceId, toolName: "bash" }) },
        async (ctx) => {
          const result = await resolveInspectTraceTool({ localEnabled: true })!.execute(
            { traceId, limit: 2 },
            ctx,
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
            ctx,
          );
          expect(page).toMatchObject({
            hasMore: false,
            offset: 1,
            timeline: [{ category: "tool", spanId: toolSpanId }],
            total: 2,
          });
        },
      );
    });

    it("returns selected payloads with project-relative segment paths", async () => {
      await withTraceStore(
        { [traceId]: segment({ id: traceId, toolName: "bash" }) },
        async (ctx) => {
          const result = await resolveInspectTraceSpansTool({ localEnabled: true })!.execute(
            { include: ["arguments", "result"], spanIds: [toolSpanId, "c".repeat(16)], traceId },
            ctx,
          );

          expect(result).toEqual({
            traceId,
            truncated: false,
            spans: [
              expect.objectContaining({
                availableFields: ["arguments", "result"],
                fields: { arguments: "x".repeat(250), result: "tool result" },
                found: true,
                rawPath: `.eve/traces/v1/${traceId}/segments/${spanId}.otlp.json`,
                spanId: toolSpanId,
              }),
              { found: false, spanId: "c".repeat(16) },
            ],
          });
        },
      );
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
});
