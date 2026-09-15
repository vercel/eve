import type { ToolContext } from "eve/tools";

import type { ResolvedDeployedSelfModificationConfig } from "./config.js";
import { resolveConversationTraceScope, unavailable } from "./trace-scope.js";
import { createVercelAgentRunsClient, type VercelAgentRunsClient } from "./vercel-trace-client.js";

const MAX_TIMELINE_RECORDS = 200;
const MAX_FIELD_BYTES = 16 * 1024;
const MAX_TOTAL_FIELD_BYTES = 32 * 1024;
const encoder = new TextEncoder();

export interface VercelConversationTraceReader {
  inspect(
    ctx: Pick<ToolContext, "session">,
    input: { readonly limit: number; readonly offset: number; readonly traceRef: string },
  ): Promise<Record<string, unknown>>;
  inspectSpans(
    ctx: Pick<ToolContext, "session">,
    input: {
      readonly include: readonly TraceField[];
      readonly spanRefs: readonly string[];
      readonly traceRef: string;
    },
  ): Promise<Record<string, unknown>>;
  search(
    ctx: Pick<ToolContext, "session">,
    input: { readonly failedOnly?: boolean },
  ): Promise<Record<string, unknown>>;
}

export type TraceField = "arguments" | "result" | "error";

export function createVercelConversationTraceReader(
  deployed: ResolvedDeployedSelfModificationConfig,
  client?: VercelAgentRunsClient,
): VercelConversationTraceReader {
  const traceClient = client ?? createVercelAgentRunsClient();

  async function read(
    ctx: Pick<ToolContext, "session">,
    traceRef: string | undefined,
    trace: boolean,
  ) {
    const scope = await resolveConversationTraceScope(deployed, ctx);
    if (traceRef !== undefined && traceRef !== scope.rootSessionId) throw unavailable();
    const data = await traceClient.getRun({ runId: scope.rootSessionId, trace });
    const run = readRun(data);
    if (readString(run, "id", "runId") !== scope.rootSessionId) throw unavailable();
    return { data, run, scope };
  }

  return {
    async search(ctx, input) {
      const { run, scope } = await read(ctx, undefined, false);
      const failed = isFailed(run);
      const summary = summarize(run, scope.rootSessionId, 0);
      return {
        conversationId: scope.rootSessionId,
        coverage: {
          complete: true,
          considered: 1,
          matched: input.failedOnly && !failed ? 0 : 1,
          stored: 1,
        },
        matches: input.failedOnly && !failed ? [] : [summary],
        truncated: false,
      };
    },

    async inspect(ctx, input) {
      const { data, run, scope } = await read(ctx, input.traceRef, true);
      const verified = verifiedRecords(data, scope.rootSessionId);
      const records = verified.records;
      const timeline = records.slice(input.offset, input.offset + input.limit).map(toTimeline);
      return {
        traceRef: scope.rootSessionId,
        offset: input.offset,
        timeline,
        summary: summarize(run, scope.rootSessionId, records.length),
        total: records.length,
        hasMore: input.offset + timeline.length < records.length,
        truncated: input.offset + timeline.length < records.length,
        coverage:
          records.length === 0
            ? {
                complete: false,
                warning: "No verifiable trace records are available yet.",
              }
            : verified.truncated
              ? { complete: false, warning: "Some trace records were omitted." }
              : { complete: true },
      };
    },

    async inspectSpans(ctx, input) {
      const { data, scope } = await read(ctx, input.traceRef, true);
      const byId = new Map(
        verifiedRecords(data, scope.rootSessionId).records.map((record) => [record.id, record]),
      );
      let remaining = MAX_TOTAL_FIELD_BYTES;
      let truncated = false;
      const spans = input.spanRefs.map((spanRef) => {
        const record = byId.get(spanRef);
        if (record === undefined) return { found: false, spanRef };
        const availableFields = fields(record.attributes);
        const values: Record<string, string> = {};
        let spanTruncated = false;
        for (const field of input.include) {
          const value = fieldValue(record.attributes, field);
          if (value === undefined) continue;
          const maximum = Math.min(MAX_FIELD_BYTES, remaining);
          values[field] = truncateUtf8(value, maximum);
          remaining -= utf8Length(values[field]);
          if (values[field].length < value.length) spanTruncated = true;
        }
        truncated ||= spanTruncated;
        return { availableFields, fields: values, found: true, spanRef, truncated: spanTruncated };
      });
      return { traceRef: scope.rootSessionId, spans, truncated };
    },
  };
}

interface VerifiedTraceRecords {
  readonly records: readonly TraceRecord[];
  readonly truncated: boolean;
}

interface TraceRecord {
  readonly attributes: Readonly<Record<string, string>>;
  readonly id: string;
  readonly name: string;
  readonly timestamp?: string;
}

function readRun(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) throw unavailable();
  return isRecord(data.run) ? data.run : data;
}

function verifiedRecords(data: unknown, rootSessionId: string): VerifiedTraceRecords {
  if (!isRecord(data)) return { records: [], truncated: false };
  const trace = isRecord(data.trace) ? data.trace : data;
  const spans = Array.isArray(trace.spans) ? trace.spans : [];
  const verified: TraceRecord[] = [];
  for (const span of spans.slice(0, MAX_TIMELINE_RECORDS)) {
    if (!isRecord(span)) continue;
    const id = readString(span, "spanId", "id");
    if (id === undefined || id.length > 256) continue;
    const attributes = readAttributes(span.attributes);
    if (attributes["agent.run.id"] !== rootSessionId) continue;
    verified.push({
      attributes,
      id,
      name: readString(span, "name", "operationName") ?? "operation",
      timestamp: readString(span, "timestamp", "startedAt", "startTime"),
    });
  }
  return { records: verified, truncated: spans.length > MAX_TIMELINE_RECORDS };
}

function toTimeline(record: TraceRecord): Record<string, unknown> {
  const availableFields = fields(record.attributes);
  const argumentsValue = fieldValue(record.attributes, "arguments");
  const operation = record.attributes["gen_ai.operation.name"];
  const toolName = record.attributes["gen_ai.tool.name"];
  const timeline: Record<string, unknown> = {
    availableFields,
    category: toolName !== undefined || operation === "execute_tool" ? "tool" : "model",
    name: bounded(record.name, 500),
    spanRef: record.id,
  };
  if (argumentsValue !== undefined) timeline.argumentsPreview = bounded(argumentsValue, 200);
  if (toolName !== undefined) timeline.toolName = bounded(toolName, 256);
  if (record.timestamp !== undefined) timeline.timestamp = bounded(record.timestamp, 128);
  return timeline;
}

function summarize(run: Record<string, unknown>, traceRef: string, recordCount: number) {
  const usage = isRecord(run.usage) ? run.usage : run;
  const input = readNumber(usage, "inputTokens", "promptTokens", "input") ?? 0;
  const output = readNumber(usage, "outputTokens", "completionTokens", "output") ?? 0;
  return {
    durationMs: readNumber(run, "durationMs", "duration"),
    errorSpanCount: isFailed(run) ? 1 : 0,
    inputTokens: input,
    outputTokens: output,
    recordCount,
    status: bounded(readString(run, "status", "state") ?? "", 100),
    traceRef,
  };
}

function isFailed(run: Record<string, unknown>): boolean {
  return /^(error|errored|failed|timed[ _-]out)$/iu.test(readString(run, "status", "state") ?? "");
}

function fields(attributes: Readonly<Record<string, string>>): TraceField[] {
  if (!isContentVisible(attributes)) return [];
  return (["arguments", "result", "error"] as const).filter(
    (field) => fieldValue(attributes, field) !== undefined,
  );
}

function fieldValue(
  attributes: Readonly<Record<string, string>>,
  field: TraceField,
): string | undefined {
  if (!isContentVisible(attributes)) return undefined;
  const key =
    field === "arguments"
      ? "gen_ai.tool.call.arguments"
      : field === "result"
        ? "gen_ai.tool.call.result"
        : "error.message";
  return attributes[key];
}

function isContentVisible(attributes: Readonly<Record<string, string>>): boolean {
  const audiences = [
    attributes["agent.channel.audience"],
    attributes["ai.settings.context.eve.channel.audience"],
  ].filter((audience): audience is string => audience !== undefined);
  return audiences.length > 0 && audiences.every((audience) => audience === "public");
}

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function truncateUtf8(value: string, maximum: number): string {
  if (utf8Length(value) <= maximum) return value;

  let bytes = 0;
  let end = 0;
  while (end < value.length) {
    const codePoint = value.codePointAt(end)!;
    const width = codePoint > 0xffff ? 2 : 1;
    const size = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + size > maximum) break;
    bytes += size;
    end += width;
  }
  return value.slice(0, end);
}

function readAttributes(value: unknown): Record<string, string> {
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => {
        const parsed = attributeValue(entry);
        return parsed === undefined ? [] : [[key, parsed]];
      }),
    );
  }
  if (!Array.isArray(value)) return {};
  return Object.fromEntries(
    value.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.key !== "string") return [];
      const parsed = attributeValue(entry.value);
      return parsed === undefined ? [] : [[entry.key, parsed]];
    }),
  );
}

function attributeValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  for (const key of ["stringValue", "value"] as const) {
    if (typeof value[key] === "string") return value[key];
  }
  return undefined;
}

function readString(
  record: Record<string, unknown>,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function readNumber(
  record: Record<string, unknown>,
  ...keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
