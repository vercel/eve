import { defineTool } from "eve/tools";

import { context, trace } from "#compiled/@opentelemetry/api/index.js";
import { queryLocalTraceSummaries, type LocalTraceSortBy } from "#tracing/local-trace-query.js";
import { summarizeLocalTrace, type LocalTraceSummary } from "#tracing/local-trace-summary.js";
import { resolveConversationId } from "#tracing/conversation-context.js";
import {
  localTraceConversationMarker,
  localTraceIndexedMarker,
} from "#tracing/local-trace-discovery-index.js";

import type { ResolvedSelfModificationConfig } from "../../../../config.js";
import { defineLocalOnlyDynamic, resolveLocalOnly } from "../../../local-only.js";
import {
  readTraceSources,
  TRACE_ID,
  type LocalTraceSpanSource,
} from "../../../trace-inspection.js";

const MAX_ANALYZED_TRACES = 200;
const MAX_UNINDEXED_TRACES = 100;
const DEFAULT_LIMIT = 20;
const MAX_RESULTS = 50;

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    agentName: { type: "string", minLength: 1 },
    failedOnly: {
      type: "boolean",
      description: "Only traces containing error spans; this does not imply the activation failed.",
    },
    limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
    sessionId: { type: "string", minLength: 1 },
    sortBy: {
      enum: ["duration", "failures", "inputTokens", "latest"],
      type: "string",
      description:
        "Rank examined traces by elapsed time, error-span count, summed step input tokens, or start time.",
    },
    toolName: {
      type: "string",
      minLength: 1,
      description: "Match tool operations, not other named actions such as subagent lifetimes.",
    },
  },
} as const;

interface SearchInput {
  readonly agentName?: string;
  readonly failedOnly?: boolean;
  readonly limit: number;
  readonly sessionId?: string;
  readonly sortBy: LocalTraceSortBy;
  readonly toolName?: string;
}

const searchTracesTool = defineTool({
  description:
    "Search structural summaries for traces in the invoking conversation. Filter by session, agent, tool, or failures; then inspect a returned trace with selfmod__inspect_trace. Prompts and tool payloads are never searched.",
  inputSchema,
  outputSchema: { type: "object", additionalProperties: true },
  async execute(input, ctx) {
    const parsed = parseInput(input);
    const currentTraceId = trace.getSpan(context.active())?.spanContext().traceId;
    const conversationId = resolveConversationId(
      ctx.session.parent?.rootSessionId ?? ctx.session.id,
    );
    const sandbox = await ctx.getSandbox();
    const [available, indexed, conversation] = await Promise.all([
      sandbox.run({ command: "ls -1dt /traces/*" }),
      sandbox.run({ command: `ls -1 /traces/*/${localTraceIndexedMarker()}` }),
      sandbox.run({ command: `ls -1 /traces/*/${localTraceConversationMarker(conversationId)}` }),
    ]);
    if (available.exitCode !== 0 && !isEmptyTraceListing(available)) {
      throw new Error(`Could not list local traces: ${available.stderr}`);
    }

    const stored = [...traceIds(available.stdout)];
    const eligible = stored.filter((traceId) => traceId !== currentTraceId);
    const indexedIds = traceIds(indexed.stdout);
    const matchingIds = new Set(traceIds(conversation.stdout));
    const unindexed = eligible.filter((traceId) => !indexedIds.has(traceId));
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

    const matched = eligible.filter((traceId) => matchingIds.has(traceId));
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
      stored: stored.length,
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
  for (const key of ["agentName", "sessionId", "toolName"] as const) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || input[key].length === 0)) {
      throw new Error(`${key} must be a non-empty string.`);
    }
  }
  if (input.failedOnly !== undefined && typeof input.failedOnly !== "boolean") {
    throw new Error("failedOnly must be a boolean.");
  }
  if (
    input.limit !== undefined &&
    (typeof input.limit !== "number" ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_RESULTS)
  ) {
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
    agentName: input.agentName as string | undefined,
    failedOnly: input.failedOnly as boolean | undefined,
    limit: (input.limit as number | undefined) ?? DEFAULT_LIMIT,
    sessionId: input.sessionId as string | undefined,
    sortBy: (input.sortBy as LocalTraceSortBy | undefined) ?? "latest",
    toolName: input.toolName as string | undefined,
  };
}

function traceIds(value: string): Set<string> {
  const ids = new Set<string>();
  for (const line of value.split(/\r?\n/u)) {
    const id = line
      .split("/")
      .filter(Boolean)
      .find((part) => TRACE_ID.test(part));
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

function isEmptyTraceListing(result: {
  readonly stderr: string;
  readonly stdout: string;
}): boolean {
  return (
    result.stdout.trim() === "" &&
    result.stderr.includes("/traces/*") &&
    /no such file or directory/iu.test(result.stderr)
  );
}

function contains(
  sources: readonly LocalTraceSpanSource[],
  attribute: string,
  expected: string,
): boolean {
  return sources.some(({ span }) => span.attributes[attribute] === expected);
}

export function resolveSearchTracesTool(config: ResolvedSelfModificationConfig) {
  return resolveLocalOnly(config, searchTracesTool);
}

export default defineLocalOnlyDynamic(searchTracesTool);
