import { join } from "node:path";

import { defineTool } from "eve/tools";

import { context, trace } from "#compiled/@opentelemetry/api/index.js";
import { resolveConversationId } from "#shared/conversation-identity.js";
import { pathExists } from "#shared/path-exists.js";
import {
  localTraceConversationMarker,
  localTraceIndexedMarker,
} from "#tracing/local/trace-discovery-index.js";
import { queryLocalTraceSummaries, type LocalTraceSortBy } from "#tracing/local/trace-query.js";
import { listLocalTraceIds, readLocalTraceActivityMs } from "#tracing/local/trace-reader.js";
import { resolveLocalTraceSchemaDirectory } from "#tracing/local/trace-span-processor.js";
import { summarizeLocalTrace, type LocalTraceSummary } from "#tracing/local/trace-summary.js";

import { defineLocalOnlyDynamic } from "../../../local-only.js";
import {
  readTraceSources,
  requireLocalTraceAppRoot,
  type LocalTraceSpanSource,
} from "../../../trace-inspection.js";

const MAX_ANALYZED_TRACES = 200;
const MAX_UNINDEXED_TRACES = 100;
const DEFAULT_SORT_BY = "latest";
const MAX_RESULTS = 50;

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_RESULTS,
      default: MAX_RESULTS,
    },
    sortBy: {
      enum: ["duration", "failures", "inputTokens", "latest"],
      type: "string",
      default: DEFAULT_SORT_BY,
      description:
        "Rank examined traces by elapsed time, error-span count, summed step input tokens, or start time. Defaults to latest.",
    },
  },
} as const;

interface SearchInput {
  readonly limit: number;
  readonly sortBy: LocalTraceSortBy;
}

const searchTracesTool = defineTool({
  description: "Search summaries for traces in the invoking conversation.",
  inputSchema,
  outputSchema: { type: "object", additionalProperties: true },
  async execute(input, ctx) {
    const parsed = parseInput(input);
    if (ctx.abortSignal.aborted) throw new Error("Trace search was cancelled.");
    const currentTraceId = trace.getSpan(context.active())?.spanContext().traceId;
    const conversationId = resolveConversationId(
      ctx.session.parent?.rootSessionId ?? ctx.session.id,
    );
    const appRoot = requireLocalTraceAppRoot();
    const schemaDirectory = resolveLocalTraceSchemaDirectory(appRoot);
    const rawIds = await listLocalTraceIds(appRoot);
    const indexedMarker = localTraceIndexedMarker();
    const conversationMarker = localTraceConversationMarker(conversationId);
    const entries = (
      await Promise.all(
        rawIds
          .filter((traceId) => traceId !== currentTraceId)
          .map(async (traceId) => {
            const traceDirectory = join(schemaDirectory, traceId);
            const [activityMs, markers] = await Promise.all([
              readLocalTraceActivityMs(appRoot, traceId).catch(() => undefined),
              Promise.all([
                pathExists(join(traceDirectory, indexedMarker)),
                pathExists(join(traceDirectory, conversationMarker)),
              ]).catch(() => [false, false] as const),
            ]);
            return {
              activityMs: activityMs ?? 0,
              indexed: markers[0],
              matchesConversation: markers[1],
              traceId,
            };
          }),
      )
    ).sort(
      (left, right) =>
        right.activityMs - left.activityMs || left.traceId.localeCompare(right.traceId),
    );

    const matchingIds = new Set(
      entries.filter((entry) => entry.matchesConversation).map((entry) => entry.traceId),
    );
    const unindexed = entries.filter((entry) => !entry.indexed).map((entry) => entry.traceId);
    const scannedUnindexed = unindexed.slice(0, MAX_UNINDEXED_TRACES);
    const digests = new Map<string, LocalTraceSummary>();
    let readFailures = 0;
    const read = async (traceId: string): Promise<LocalTraceSpanSource[] | undefined> => {
      try {
        return await readTraceSources(traceId, ctx);
      } catch (error) {
        if (ctx.abortSignal.aborted) throw error;
        readFailures += 1;
        return undefined;
      }
    };

    for (const traceId of scannedUnindexed) {
      if (ctx.abortSignal.aborted) throw new Error("Trace search was cancelled.");
      const sources = await read(traceId);
      if (sources === undefined || !contains(sources, "gen_ai.conversation.id", conversationId))
        continue;
      matchingIds.add(traceId);
      digests.set(
        traceId,
        summarizeLocalTrace(
          traceId,
          sources.map(({ span }) => span),
        ),
      );
    }

    const matched = entries.map((entry) => entry.traceId).filter((id) => matchingIds.has(id));
    const considered = matched.slice(0, MAX_ANALYZED_TRACES);
    const summaries: LocalTraceSummary[] = [];
    for (const traceId of considered) {
      if (ctx.abortSignal.aborted) throw new Error("Trace search was cancelled.");
      const cached = digests.get(traceId);
      if (cached !== undefined) {
        summaries.push(cached);
        continue;
      }
      const sources = await read(traceId);
      if (sources !== undefined)
        summaries.push(
          summarizeLocalTrace(
            traceId,
            sources.map(({ span }) => span),
          ),
        );
    }
    const results = queryLocalTraceSummaries(summaries, parsed);
    const omitted = unindexed.length - scannedUnindexed.length + matched.length - considered.length;
    const coverage: {
      complete: boolean;
      considered: number;
      matched: number;
      stored: number;
      warning?: string;
    } = {
      complete: omitted === 0 && readFailures === 0,
      considered: considered.length,
      matched: matched.length,
      stored: rawIds.length,
    };
    const warnings = [];
    if (omitted !== 0) warnings.push("Some older traces could not be included.");
    if (readFailures !== 0) warnings.push("Some traces could not be read.");
    if (warnings.length > 0) coverage.warning = warnings.join(" ");
    return {
      conversationId,
      coverage,
      matches: results.matches,
      truncated: results.truncated,
    };
  },
});

function parseInput(value: unknown): SearchInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Trace search input must be an object.");
  }
  const input = value as Record<string, unknown>;
  const limit = input.limit === undefined ? MAX_RESULTS : input.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new Error(`limit must be an integer between 1 and ${MAX_RESULTS}.`);
  }
  if (
    input.sortBy !== undefined &&
    input.sortBy !== "latest" &&
    input.sortBy !== "duration" &&
    input.sortBy !== "failures" &&
    input.sortBy !== "inputTokens"
  ) {
    throw new Error("sortBy must be latest, duration, failures, or inputTokens.");
  }
  return {
    limit,
    sortBy: (input.sortBy as LocalTraceSortBy | undefined) ?? DEFAULT_SORT_BY,
  };
}

function contains(
  sources: readonly LocalTraceSpanSource[],
  attribute: string,
  expected: string,
): boolean {
  return sources.some(({ span }) => span.attributes[attribute] === expected);
}

export default defineLocalOnlyDynamic(searchTracesTool);
