import { defineDynamic, defineTool } from "eve/tools";

import { createVercelConversationTraceReader } from "../../vercel-conversation-trace-reader.js";
import {
  resolveSelfModificationConfig,
  type ResolvedSelfModificationConfig,
} from "../../config.js";
import { resolveSelfModificationMode } from "../../mode.js";
import { hasVercelTraceBackend } from "../../trace-scope.js";
import selfModification from "../extension.js";
import { resolveLocalOnly } from "../local-only.js";
import { detailFields, readTraceSources, SPAN_ID, TRACE_ID } from "../trace-inspection.js";

const FIELDS = ["arguments", "result", "error"] as const;
type Field = (typeof FIELDS)[number];
const MAX_SPANS = 10;
const MAX_FIELD_BYTES = 16 * 1024;
const MAX_TOTAL_FIELD_BYTES = 32 * 1024;

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    include: {
      type: "array",
      minItems: 1,
      maxItems: FIELDS.length,
      items: { enum: FIELDS, type: "string" },
    },
    spanIds: {
      type: "array",
      minItems: 1,
      maxItems: MAX_SPANS,
      items: { type: "string", pattern: "^[0-9a-f]{16}$" },
    },
    traceId: { type: "string", pattern: "^[0-9a-f]{32}$" },
  },
  required: ["traceId", "spanIds", "include"],
} as const;

const inspectTraceSpansTool = defineTool({
  description:
    "Return bounded arguments, results, or errors for selected spans in one trace. First use selfmod__inspect_trace to choose spanIds and see availableFields.",
  inputSchema,
  outputSchema: { type: "object", additionalProperties: true },
  async execute(input, ctx) {
    const { include, spanIds, traceId } = parseInput(input);
    const sources = new Map(
      (await readTraceSources(traceId, ctx)).map((source) => [source.span.spanId, source]),
    );
    let remainingBytes = MAX_TOTAL_FIELD_BYTES;
    let truncated = false;
    const spans = spanIds.map((spanId) => {
      const source = sources.get(spanId);
      if (source === undefined) return { spanId, found: false };
      const values = detailFields(source);
      const availableFields = FIELDS.filter((field) => typeof values[field] === "string");
      const fields: Record<string, string> = {};
      let spanTruncated = false;
      for (const field of include) {
        const value = values[field];
        if (typeof value !== "string") continue;
        const maximum = Math.min(MAX_FIELD_BYTES, remainingBytes);
        fields[field] = value.slice(0, maximum);
        remainingBytes -= fields[field].length;
        if (value.length > maximum) spanTruncated = true;
      }
      truncated ||= spanTruncated;
      return {
        spanId,
        found: true,
        availableFields,
        fields,
        rawPath: `/traces/${traceId}/segments/${source.segmentFile}`,
        truncated: spanTruncated,
      };
    });
    return { traceId, spans, truncated };
  },
});

const vercelInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    include: {
      type: "array",
      minItems: 1,
      maxItems: FIELDS.length,
      items: { enum: FIELDS, type: "string" },
    },
    spanRefs: {
      type: "array",
      minItems: 1,
      maxItems: MAX_SPANS,
      items: { type: "string", minLength: 1, maxLength: 256 },
    },
    traceRef: { type: "string", minLength: 1, maxLength: 256 },
  },
  required: ["traceRef", "spanRefs", "include"],
} as const;

function vercelInspectTraceSpansTool(config: ResolvedSelfModificationConfig) {
  if (resolveSelfModificationMode(config) !== "deployed" || !hasVercelTraceBackend()) return null;
  const reader = createVercelConversationTraceReader(config.deployed!);
  return defineTool({
    description:
      "Return bounded recorded tool fields for selected timeline spans in the invoking conversation only.",
    inputSchema: vercelInputSchema,
    outputSchema: { type: "object", additionalProperties: true },
    async execute(input, ctx) {
      const parsed = parseVercelInput(input);
      return await reader.inspectSpans(ctx, parsed);
    },
  }) as typeof inspectTraceSpansTool;
}

function parseVercelInput(value: unknown): {
  readonly include: readonly Field[];
  readonly spanRefs: readonly string[];
  readonly traceRef: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Trace span inspection input must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.traceRef !== "string" ||
    input.traceRef.length === 0 ||
    input.traceRef.length > 256
  ) {
    throw new Error("traceRef must be a non-empty inspection reference.");
  }
  if (
    !Array.isArray(input.spanRefs) ||
    input.spanRefs.length === 0 ||
    input.spanRefs.length > MAX_SPANS ||
    input.spanRefs.some(
      (spanRef) => typeof spanRef !== "string" || spanRef.length === 0 || spanRef.length > 256,
    )
  ) {
    throw new Error(`spanRefs must contain between 1 and ${MAX_SPANS} inspection references.`);
  }
  if (
    !Array.isArray(input.include) ||
    input.include.length === 0 ||
    input.include.length > FIELDS.length ||
    input.include.some((field) => !FIELDS.includes(field as Field))
  ) {
    throw new Error("include must contain arguments, result, or error.");
  }
  return {
    include: input.include as Field[],
    spanRefs: [...new Set(input.spanRefs as string[])],
    traceRef: input.traceRef,
  };
}

export function resolveInspectTraceSpansTool(config: ResolvedSelfModificationConfig) {
  return resolveLocalOnly(config, inspectTraceSpansTool) ?? vercelInspectTraceSpansTool(config);
}

export default defineDynamic({
  events: {
    "session.started": () =>
      resolveInspectTraceSpansTool(resolveSelfModificationConfig(selfModification.config)),
  },
});

function parseInput(value: unknown): {
  readonly include: readonly Field[];
  readonly spanIds: readonly string[];
  readonly traceId: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Trace span inspection input must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.traceId !== "string" || !TRACE_ID.test(input.traceId)) {
    throw new Error("traceId must be a lowercase 32-character hex id.");
  }
  if (
    !Array.isArray(input.spanIds) ||
    input.spanIds.length === 0 ||
    input.spanIds.length > MAX_SPANS ||
    input.spanIds.some((spanId) => typeof spanId !== "string" || !SPAN_ID.test(spanId))
  ) {
    throw new Error(`spanIds must contain between 1 and ${MAX_SPANS} lowercase span ids.`);
  }
  if (
    !Array.isArray(input.include) ||
    input.include.length === 0 ||
    input.include.length > FIELDS.length ||
    input.include.some((field) => !FIELDS.includes(field as Field))
  ) {
    throw new Error("include must contain arguments, result, or error.");
  }
  return {
    include: input.include as Field[],
    spanIds: [...new Set(input.spanIds as string[])],
    traceId: input.traceId,
  };
}
