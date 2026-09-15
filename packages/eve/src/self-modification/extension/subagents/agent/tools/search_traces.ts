import { defineTool } from "eve/tools";

import { context, trace } from "#compiled/@opentelemetry/api/index.js";
import {
  analyzeLocalTrace,
  type LocalTraceSpanSource,
} from "#self-modification/local-trace-analysis.js";
import { resolveConversationId } from "#tracing/conversation-context.js";
import {
  localTraceConversationMarker,
  localTraceIndexedMarker,
} from "#tracing/local-trace-discovery-index.js";

import { readTraceSources, TRACE_ID } from "../../../trace-inspection.js";

const MAX_ANALYZED_TRACES = 200;
const MAX_UNINDEXED_TRACES = 100;
const DEFAULT_LIMIT = 20;
const MAX_RESULTS = 50;

type SortBy = "duration" | "failures" | "inputTokens" | "latest";

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    agentName: { type: "string", minLength: 1 },
    failedOnly: { type: "boolean" },
    limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
    sessionId: { type: "string", minLength: 1 },
    sortBy: { enum: ["duration", "failures", "inputTokens", "latest"], type: "string" },
    toolName: { type: "string", minLength: 1 },
  },
} as const;

interface SearchInput {
  readonly agentName?: string;
  readonly failedOnly?: boolean;
  readonly limit: number;
  readonly sessionId?: string;
  readonly sortBy: SortBy;
  readonly toolName?: string;
}

interface TraceSummary {
  readonly agentNames: readonly string[];
  readonly durationMs: number;
  readonly failedOperations: number;
  readonly inputTokens: number;
  readonly modelCalls: number;
  readonly models: readonly string[];
  readonly outputTokens: number;
  readonly sessionIds: readonly string[];
  readonly startedAt: string;
  readonly toolCalls: number;
  readonly toolNames: readonly string[];
  readonly traceId: string;
}

export default defineTool({
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
    if (available.exitCode !== 0)
      throw new Error(`Could not list local traces: ${available.stderr}`);

    const stored = [...traceIds(available.stdout)];
    const eligible = stored.filter((traceId) => traceId !== currentTraceId);
    const indexedIds = traceIds(indexed.stdout);
    const matchingIds = new Set(traceIds(conversation.stdout));
    const unindexed = eligible.filter((traceId) => !indexedIds.has(traceId));
    const scannedUnindexed = unindexed.slice(0, MAX_UNINDEXED_TRACES);
    const digests = new Map<string, TraceSummary>();

    for (const traceId of scannedUnindexed) {
      if (ctx.abortSignal.aborted) throw new Error("Trace search was cancelled.");
      const sources = await readTraceSources(traceId, ctx);
      if (!contains(sources, "gen_ai.conversation.id", conversationId)) continue;
      matchingIds.add(traceId);
      digests.set(traceId, summarize(traceId, sources));
    }

    const matched = eligible.filter((traceId) => matchingIds.has(traceId));
    const considered = matched.slice(0, MAX_ANALYZED_TRACES);
    const summaries: TraceSummary[] = [];
    for (const traceId of considered) {
      if (ctx.abortSignal.aborted) throw new Error("Trace search was cancelled.");
      const summary =
        digests.get(traceId) ?? summarize(traceId, await readTraceSources(traceId, ctx));
      if (!matches(summary, parsed)) continue;
      summaries.push(summary);
    }
    sort(summaries, parsed.sortBy);
    const results = summaries.slice(0, parsed.limit);
    const omitted = unindexed.length - scannedUnindexed.length + matched.length - considered.length;
    const coverage: {
      complete: boolean;
      considered: number;
      matched: number;
      stored: number;
      warning?: string;
    } = {
      complete: omitted === 0,
      considered: considered.length,
      matched: matched.length,
      stored: stored.length,
    };
    if (omitted !== 0) coverage.warning = "Some older traces could not be included.";
    return {
      conversationId,
      coverage,
      matches: results,
      truncated: summaries.length > results.length,
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
    sortBy: (input.sortBy as SortBy | undefined) ?? "latest",
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

function summarize(traceId: string, sources: readonly LocalTraceSpanSource[]): TraceSummary {
  const analysis = analyzeLocalTrace(sources);
  const names = (attribute: string) => [
    ...new Set(
      sources.flatMap(({ span }) =>
        typeof span.attributes[attribute] === "string"
          ? [span.attributes[attribute] as string]
          : [],
      ),
    ),
  ];
  const maximum = (attribute: string) =>
    sources.reduce((maximum, { span }) => {
      const value = Number(span.attributes[attribute]);
      return Number.isFinite(value) ? Math.max(maximum, value) : maximum;
    }, 0);
  return {
    agentNames: names("agent.name"),
    durationMs: analysis.durationMs,
    failedOperations: analysis.records.filter((record) => record.outcome === "failed").length,
    inputTokens: maximum("agent.usage.input_tokens"),
    modelCalls: analysis.modelCalls,
    models: [
      ...new Set(
        analysis.records.flatMap((record) => (record.model === undefined ? [] : [record.model])),
      ),
    ],
    outputTokens: maximum("agent.usage.output_tokens"),
    sessionIds: names("agent.session.id"),
    startedAt: new Date(Number(analysis.startTimeNs / 1_000_000n)).toISOString(),
    toolCalls: analysis.toolCalls,
    toolNames: [
      ...new Set(
        analysis.records.flatMap((record) =>
          record.toolName === undefined ? [] : [record.toolName],
        ),
      ),
    ],
    traceId,
  };
}

function contains(
  sources: readonly LocalTraceSpanSource[],
  attribute: string,
  expected: string,
): boolean {
  return sources.some(({ span }) => span.attributes[attribute] === expected);
}

function matches(summary: TraceSummary, input: SearchInput): boolean {
  return (
    (input.agentName === undefined || summary.agentNames.includes(input.agentName)) &&
    (input.sessionId === undefined || summary.sessionIds.includes(input.sessionId)) &&
    (input.toolName === undefined || summary.toolNames.includes(input.toolName)) &&
    (input.failedOnly !== true || summary.failedOperations > 0)
  );
}

function sort(summaries: TraceSummary[], sortBy: SortBy): void {
  summaries.sort((left, right) => {
    const difference =
      sortBy === "duration"
        ? right.durationMs - left.durationMs
        : sortBy === "failures"
          ? right.failedOperations - left.failedOperations
          : sortBy === "inputTokens"
            ? right.inputTokens - left.inputTokens
            : Date.parse(right.startedAt) - Date.parse(left.startedAt);
    return difference || left.traceId.localeCompare(right.traceId);
  });
}
