import { defineTool } from "eve/tools";

import { analyzeLocalTrace } from "#self-modification/local-trace-analysis.js";

import { boundedText, detailFields, readTraceSources, TRACE_ID } from "../../../trace-inspection.js";

const MAX_RECORDS = 200;
const DEFAULT_RECORDS = 40;
const MAX_ARGUMENT_PREVIEW = 200;

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: MAX_RECORDS },
    traceId: { type: "string", pattern: "^[0-9a-f]{32}$" },
  },
  required: ["traceId"],
} as const;

export default defineTool({
  description:
    "Inspect one trace as a bounded structural timeline. Tool records include a short argument preview and availableFields; use selfmod__inspect_trace_spans only for selected raw tool payloads.",
  inputSchema,
  outputSchema: { type: "object", additionalProperties: true },
  async execute(input, ctx) {
    const { limit, traceId } = parseInput(input);
    const sources = await readTraceSources(traceId, ctx);
    const analysis = analyzeLocalTrace(sources);
    const byId = new Map(sources.map((source) => [source.span.spanId, source]));
    const records = analysis.records.slice(0, limit).map((record) => {
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
      timeline: records,
      totals: {
        durationMs: analysis.durationMs,
        modelCalls: analysis.modelCalls,
        modelDurationMs: analysis.modelDurationMs,
        toolCalls: analysis.toolCalls,
        toolDurationMs: analysis.toolDurationMs,
      },
      groups: analysis.groups,
      truncated: analysis.records.length > records.length,
    };
  },
});

function parseInput(value: unknown): { readonly limit: number; readonly traceId: string } {
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
  return { limit: (input.limit as number | undefined) ?? DEFAULT_RECORDS, traceId: input.traceId };
}

function boundedRecord(
  record: ReturnType<typeof analyzeLocalTrace>["records"][number],
): ReturnType<typeof analyzeLocalTrace>["records"][number] {
  return record.error === undefined ? record : { ...record, error: boundedText(record.error, 500) };
}
