import { defineDynamic, defineTool } from "eve/tools";

import { analyzeLocalTrace } from "#tracing/local-trace-analysis.js";

import { createVercelConversationTraceReader } from "../../vercel-conversation-trace-reader.js";
import {
  resolveSelfModificationConfig,
  type ResolvedSelfModificationConfig,
} from "../../config.js";
import { resolveSelfModificationMode } from "../../mode.js";
import { hasVercelTraceBackend } from "../../trace-scope.js";
import selfModification from "../extension.js";
import { resolveLocalOnly } from "../local-only.js";

import { boundedText, detailFields, readTraceSources, TRACE_ID } from "../trace-inspection.js";

const MAX_RECORDS = 200;
const MAX_OFFSET = 100_000;
const DEFAULT_RECORDS = 40;
const MAX_ARGUMENT_PREVIEW = 200;

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: MAX_RECORDS },
    offset: {
      type: "integer",
      minimum: 0,
      maximum: MAX_OFFSET,
      description: "Zero-based record offset for paging through larger traces.",
    },
    traceId: { type: "string", pattern: "^[0-9a-f]{32}$" },
  },
  required: ["traceId"],
} as const;

const inspectTraceTool = defineTool({
  description:
    "Inspect one trace as a bounded structural timeline. Use offset to page through larger traces. Tool records include a short argument preview and availableFields; use selfmod__inspect_trace_spans only for selected raw tool payloads.",
  inputSchema,
  outputSchema: { type: "object", additionalProperties: true },
  async execute(input, ctx) {
    const { limit, offset, traceId } = parseInput(input);
    const sources = await readTraceSources(traceId, ctx);
    const analysis = analyzeLocalTrace(
      traceId,
      sources.map(({ span }) => span),
    );
    const byId = new Map(sources.map((source) => [source.span.spanId, source]));
    const records = analysis.records.slice(offset, offset + limit).map((record) => {
      const source = byId.get(record.spanId);
      const fields = source === undefined ? undefined : detailFields(source);
      const availableFields =
        fields === undefined
          ? []
          : (["arguments", "result", "error"] as const).filter(
              (field) => typeof fields[field] === "string",
            );
      const argumentsValue = fields?.arguments;
      return {
        ...boundedRecord(record),
        availableFields,
        ...(record.category === "tool" && typeof argumentsValue === "string"
          ? { argumentsPreview: boundedText(argumentsValue, MAX_ARGUMENT_PREVIEW) }
          : {}),
      };
    });
    return {
      traceId,
      offset,
      timeline: records,
      summary: analysis.summary,
      modelWorkMs: analysis.modelWorkMs,
      toolWorkMs: analysis.toolWorkMs,
      groups: analysis.groups,
      total: analysis.records.length,
      hasMore: offset + records.length < analysis.records.length,
      truncated: offset + records.length < analysis.records.length,
    };
  },
});

const vercelInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: MAX_RECORDS },
    offset: { type: "integer", minimum: 0, maximum: MAX_OFFSET },
    traceRef: { type: "string", minLength: 1, maxLength: 256 },
  },
  required: ["traceRef"],
} as const;

function vercelInspectTraceTool(config: ResolvedSelfModificationConfig) {
  if (resolveSelfModificationMode(config) !== "deployed" || !hasVercelTraceBackend()) return null;
  const reader = createVercelConversationTraceReader(config.deployed!);
  return defineTool({
    description:
      "Inspect a bounded timeline from the invoking conversation's recorded Agent Run. The trace reference must come from trace search.",
    inputSchema: vercelInputSchema,
    outputSchema: { type: "object", additionalProperties: true },
    async execute(input, ctx) {
      const parsed = parseVercelInput(input);
      return await reader.inspect(ctx, parsed);
    },
  }) as typeof inspectTraceTool;
}

function parseVercelInput(value: unknown): {
  readonly limit: number;
  readonly offset: number;
  readonly traceRef: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Trace inspection input must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.traceRef !== "string" ||
    input.traceRef.length === 0 ||
    input.traceRef.length > 256
  ) {
    throw new Error("traceRef must be a non-empty inspection reference.");
  }
  const limit = input.limit ?? DEFAULT_RECORDS;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RECORDS) {
    throw new Error(`limit must be an integer between 1 and ${MAX_RECORDS}.`);
  }
  if (!Number.isInteger(offset) || (offset as number) < 0 || (offset as number) > MAX_OFFSET) {
    throw new Error(`offset must be an integer between 0 and ${MAX_OFFSET}.`);
  }
  return { limit: limit as number, offset: offset as number, traceRef: input.traceRef };
}

export function resolveInspectTraceTool(config: ResolvedSelfModificationConfig) {
  return resolveLocalOnly(config, inspectTraceTool) ?? vercelInspectTraceTool(config);
}

export default defineDynamic({
  events: {
    "session.started": () =>
      resolveInspectTraceTool(resolveSelfModificationConfig(selfModification.config)),
  },
});

function parseInput(value: unknown): {
  readonly limit: number;
  readonly offset: number;
  readonly traceId: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Trace inspection input must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.traceId !== "string" || !TRACE_ID.test(input.traceId)) {
    throw new Error("traceId must be a lowercase 32-character hex id.");
  }
  if (
    input.limit !== undefined &&
    (typeof input.limit !== "number" ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_RECORDS)
  ) {
    throw new Error(`limit must be an integer between 1 and ${MAX_RECORDS}.`);
  }
  if (
    input.offset !== undefined &&
    (typeof input.offset !== "number" ||
      !Number.isInteger(input.offset) ||
      input.offset < 0 ||
      input.offset > MAX_OFFSET)
  ) {
    throw new Error(`offset must be an integer between 0 and ${MAX_OFFSET}.`);
  }
  return {
    limit: (input.limit as number | undefined) ?? DEFAULT_RECORDS,
    offset: (input.offset as number | undefined) ?? 0,
    traceId: input.traceId,
  };
}

function boundedRecord(
  record: ReturnType<typeof analyzeLocalTrace>["records"][number],
): ReturnType<typeof analyzeLocalTrace>["records"][number] {
  return record.error === undefined ? record : { ...record, error: boundedText(record.error, 500) };
}
