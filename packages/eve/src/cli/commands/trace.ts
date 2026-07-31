import { basename } from "node:path";

import { formatElapsed } from "#cli/format-elapsed.js";
import { createCliTheme, renderCliSection, sanitizeForTerminal } from "#cli/ui/output.js";
import type { LocalTrace, LocalTraceSpan } from "#harness/local-trace-reader.js";
import {
  compareLocalTraceSpans,
  describeLocalTraceSpan,
  listLocalTraces,
} from "#harness/local-trace-reader.js";

const TRACE_DISPLAY_DIRECTORY = ".eve/traces/v1";

interface CliTraceLogger {
  error(message: string): void;
  log(message: string): void;
}

export type { LocalTrace, LocalTraceSpan };

interface SpanExtent {
  readonly endTimeNs: bigint;
  readonly startTimeNs: bigint;
}

/**
 * Resolves an exact trace/session id or an unambiguous prefix. One session id
 * can match several traces, since a long session windows into more than one.
 */
export function resolveLocalTraces(
  traces: readonly LocalTrace[],
  reference: string,
): readonly LocalTrace[] {
  const raw = reference.replaceAll("\\", "/");
  const normalized = basename(raw);
  const references = raw === normalized ? [raw] : [raw, normalized];
  const exactTrace = traces.find((trace) => references.includes(trace.traceId));
  if (exactTrace !== undefined) return [exactTrace];
  const exactSessions = traces.filter((trace) =>
    trace.sessionIds.some((sessionId) => references.includes(sessionId)),
  );
  if (exactSessions.length > 0) return orderWindows(exactSessions);

  const matches = traces.filter((trace) =>
    references.some(
      (candidate) =>
        trace.traceId.startsWith(candidate) ||
        trace.sessionIds.some((sessionId) => sessionId.startsWith(candidate)),
    ),
  );
  if (matches.length === 0) {
    throw new Error(
      `No local trace matches "${sanitizeForTerminal(reference)}". Run \`eve traces ls\` to list traces.`,
    );
  }
  if (matches.length === 1) return matches;
  const sessions = new Set(matches.map((trace) => trace.sessionId ?? trace.traceId));
  if (sessions.size > 1) throw ambiguousTraceError(matches, reference);
  return orderWindows(matches);
}

function orderWindows(traces: readonly LocalTrace[]): readonly LocalTrace[] {
  return [...traces].sort((left, right) =>
    left.startTimeNs === right.startTimeNs
      ? left.traceId.localeCompare(right.traceId)
      : left.startTimeNs < right.startTimeNs
        ? -1
        : 1,
  );
}

export async function runTraceListCommand(
  logger: CliTraceLogger,
  appRoot: string,
  options: { readonly json?: boolean } = {},
): Promise<void> {
  const traces = await listLocalTraces(appRoot);
  if (options.json === true) {
    logger.log(
      JSON.stringify(
        traces.map((trace) => ({
          agentName: trace.agentName ?? null,
          durationMs: durationMs(trace.startTimeNs, trace.endTimeNs),
          sessionId: trace.sessionId ?? null,
          spanCount: trace.spans.length,
          startedAt: toDate(trace.startTimeNs).toISOString(),
          traceId: trace.traceId,
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (traces.length === 0) {
    logger.log(`No local traces found under ${TRACE_DISPLAY_DIRECTORY}.`);
    return;
  }

  const rows = traces.map((trace) => [
    trace.traceId,
    sanitizeForTerminal(trace.sessionId ?? "unknown"),
    sanitizeForTerminal(trace.agentName ?? "unknown"),
    toDate(trace.startTimeNs).toISOString(),
    formatElapsed(durationMs(trace.startTimeNs, trace.endTimeNs)),
    String(trace.spans.length),
  ]);
  const headers = ["TRACE", "SESSION", "AGENT", "STARTED", "DURATION", "SPANS"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );
  logger.log(
    [headers, ...rows]
      .map((row) =>
        row
          .map((value, index) => value.padEnd(widths[index]!))
          .join("  ")
          .trimEnd(),
      )
      .join("\n"),
  );
}

export async function runTraceShowCommand(
  logger: CliTraceLogger,
  appRoot: string,
  reference?: string,
): Promise<void> {
  const traces = await listLocalTraces(appRoot);
  if (traces.length === 0) {
    const message = `No local traces found under ${TRACE_DISPLAY_DIRECTORY}.`;
    if (reference !== undefined) throw new Error(message);
    logger.log(message);
    return;
  }
  const selected = reference === undefined ? [traces[0]!] : resolveLocalTraces(traces, reference);
  const theme = createCliTheme();
  logger.log(
    selected
      .map((trace) =>
        [
          renderCliSection(theme, {
            rows: [
              { label: "Trace ID", value: trace.traceId },
              { label: "Session ID", value: trace.sessionId ?? "unknown" },
              ...(trace.window === undefined
                ? []
                : [{ label: "Window", value: String(trace.window) }]),
              { label: "Agent", value: trace.agentName ?? "unknown" },
              { label: "Started", value: toDate(trace.startTimeNs).toISOString() },
              {
                label: "Duration",
                value: formatElapsed(durationMs(trace.startTimeNs, trace.endTimeNs)),
              },
              { label: "Spans", value: String(trace.spans.length) },
            ],
            title: "Trace",
          }),
          `${theme.accent("Spans")}\n${renderSpanTree(trace.spans)}`,
        ].join("\n\n"),
      )
      .join("\n\n"),
  );
}

function renderSpanTree(spans: readonly LocalTraceSpan[]): string {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const children = new Map<string, LocalTraceSpan[]>();
  const roots: LocalTraceSpan[] = [];
  for (const span of spans) {
    if (span.parentSpanId === undefined || !byId.has(span.parentSpanId)) {
      roots.push(span);
    } else {
      const siblings = children.get(span.parentSpanId) ?? [];
      siblings.push(span);
      children.set(span.parentSpanId, siblings);
    }
  }
  roots.sort(compareLocalTraceSpans);
  for (const siblings of children.values()) siblings.sort(compareLocalTraceSpans);
  const extents = subtreeExtents(spans, children);

  const lines: string[] = [];
  const visited = new Set<string>();
  const render = (span: LocalTraceSpan, prefix: string, connector: string): void => {
    if (visited.has(span.spanId)) return;
    visited.add(span.spanId);
    lines.push(`${prefix}${connector}${spanLabel(span, extents.get(span.spanId))}`);
    const descendants = children.get(span.spanId) ?? [];
    descendants.forEach((child, index) => {
      const last = index === descendants.length - 1;
      render(
        child,
        `${prefix}${connector === "" ? "" : connector === "└─ " ? "   " : "│  "}`,
        last ? "└─ " : "├─ ",
      );
    });
  };
  for (const root of roots) render(root, "", "");
  for (const span of [...spans].sort(compareLocalTraceSpans)) {
    if (!visited.has(span.spanId)) render(span, "", "");
  }
  return lines.join("\n");
}

/**
 * Extent of each span's own range unioned with its descendants', keyed by span id.
 *
 * eve records a span whose lifetime crosses a durable worker boundary — a
 * session window or a turn — as a zero-duration marker, because a span object
 * cannot cross that boundary to be ended later. The tree falls back to this
 * extent for those rows so it shows where the time went.
 */
function subtreeExtents(
  spans: readonly LocalTraceSpan[],
  children: ReadonlyMap<string, readonly LocalTraceSpan[]>,
): ReadonlyMap<string, SpanExtent> {
  const extents = new Map<string, SpanExtent>();
  const pending = new Set<string>();
  const visit = (span: LocalTraceSpan): SpanExtent => {
    const cached = extents.get(span.spanId);
    if (cached !== undefined) return cached;
    if (pending.has(span.spanId))
      return { endTimeNs: span.endTimeNs, startTimeNs: span.startTimeNs };
    pending.add(span.spanId);
    let endTimeNs = span.endTimeNs;
    let startTimeNs = span.startTimeNs;
    for (const child of children.get(span.spanId) ?? []) {
      const extent = visit(child);
      if (extent.startTimeNs < startTimeNs) startTimeNs = extent.startTimeNs;
      if (extent.endTimeNs > endTimeNs) endTimeNs = extent.endTimeNs;
    }
    pending.delete(span.spanId);
    const extent = { endTimeNs, startTimeNs };
    extents.set(span.spanId, extent);
    return extent;
  };
  for (const span of spans) visit(span);
  return extents;
}

function spanLabel(span: LocalTraceSpan, extent?: SpanExtent): string {
  const details = describeLocalTraceSpan(span).map(sanitizeForTerminal);
  const detail = details.length === 0 ? "" : ` [${details.join(", ")}]`;
  const error = span.statusCode === 2 ? " ERROR" : "";
  const recorded = durationMs(span.startTimeNs, span.endTimeNs);
  const elapsed =
    recorded === 0 && extent !== undefined
      ? durationMs(extent.startTimeNs, extent.endTimeNs)
      : recorded;
  return `${sanitizeForTerminal(span.name)}${detail}  ${formatElapsed(elapsed)}${error}`;
}

function durationMs(start: bigint, end: bigint): number {
  return Number(end - start) / 1_000_000;
}

function toDate(nanoseconds: bigint): Date {
  return new Date(Number(nanoseconds / 1_000_000n));
}

function ambiguousTraceError(traces: readonly LocalTrace[], reference: string): Error {
  return new Error(
    [
      `"${sanitizeForTerminal(reference)}" matches ${traces.length} local traces:`,
      ...traces.map(
        (trace) =>
          `  ${trace.traceId}  ${sanitizeForTerminal(trace.sessionId ?? "unknown session")}`,
      ),
      "Pass a longer prefix or the full trace/session id.",
    ].join("\n"),
  );
}
