import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { formatElapsed } from "#cli/format-elapsed.js";
import { createCliTheme, renderCliSection, sanitizeForTerminal } from "#cli/ui/output.js";

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const SPAN_FILE_PATTERN = /^([0-9a-f]{16})\.otlp\.json$/u;
const TRACE_DIRECTORY_SEGMENTS = [".eve", "traces", "v1"] as const;
const TRACE_DISPLAY_DIRECTORY = TRACE_DIRECTORY_SEGMENTS.join("/");
const MAX_SEGMENT_BYTES = 8 * 1024 * 1024;
const MAX_UINT64 = 18_446_744_073_709_551_615n;

interface CliTraceLogger {
  error(message: string): void;
  log(message: string): void;
}

export interface LocalTraceSpan {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly endTimeNs: bigint;
  readonly name: string;
  readonly parentSpanId?: string;
  readonly scope?: string;
  readonly spanId: string;
  readonly startTimeNs: bigint;
  readonly statusCode: number;
  readonly traceId: string;
}

interface SpanExtent {
  readonly endTimeNs: bigint;
  readonly startTimeNs: bigint;
}

export interface LocalTrace {
  readonly agentName?: string;
  readonly endTimeNs: bigint;
  readonly sessionId?: string;
  readonly sessionIds: readonly string[];
  readonly spans: readonly LocalTraceSpan[];
  readonly startTimeNs: bigint;
  readonly traceId: string;
  readonly window?: number;
}

/** Reads valid local traces, newest first, while ignoring malformed segments. */
export async function listLocalTraces(appRoot: string): Promise<LocalTrace[]> {
  const root = join(appRoot, ...TRACE_DIRECTORY_SEGMENTS);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const traces: LocalTrace[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !TRACE_ID_PATTERN.test(entry.name)) continue;
    const trace = await readTrace(root, entry.name).catch(() => undefined);
    if (trace !== undefined) traces.push(trace);
  }
  return traces.sort((left, right) =>
    left.startTimeNs === right.startTimeNs
      ? left.traceId.localeCompare(right.traceId)
      : left.startTimeNs > right.startTimeNs
        ? -1
        : 1,
  );
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

async function readTrace(root: string, traceId: string): Promise<LocalTrace | undefined> {
  const segmentsRoot = join(root, traceId, "segments");
  let entries;
  try {
    entries = await readdir(segmentsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const spans = new Map<string, LocalTraceSpan>();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !SPAN_FILE_PATTERN.test(entry.name)) continue;
    let content: string;
    try {
      const path = join(segmentsRoot, entry.name);
      if ((await stat(path)).size > MAX_SEGMENT_BYTES) continue;
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }
    for (const span of parseSegment(content, traceId)) {
      if (!spans.has(span.spanId)) spans.set(span.spanId, span);
    }
  }
  if (spans.size === 0) return undefined;
  const ordered = [...spans.values()].sort(compareSpans);
  const attributes = ordered.map((span) => span.attributes);
  const sessionIds = distinctAttributes(attributes, "agent.session.id");
  return {
    agentName: firstAttribute(attributes, "agent.name"),
    endTimeNs: ordered.reduce(
      (value, span) => (span.endTimeNs > value ? span.endTimeNs : value),
      0n,
    ),
    sessionId: sessionIds[0],
    sessionIds,
    spans: ordered,
    startTimeNs: ordered.reduce(
      (value, span) => (span.startTimeNs < value ? span.startTimeNs : value),
      ordered[0]!.startTimeNs,
    ),
    traceId,
    window: firstNumberAttribute(attributes, "agent.session.window"),
  };
}

function parseSegment(content: string, expectedTraceId: string): LocalTraceSpan[] {
  try {
    const request = JSON.parse(content) as unknown;
    if (!isRecord(request) || !Array.isArray(request.resourceSpans)) return [];
    const spans: LocalTraceSpan[] = [];
    for (const resource of request.resourceSpans) {
      if (!isRecord(resource) || !Array.isArray(resource.scopeSpans)) continue;
      for (const scoped of resource.scopeSpans) {
        if (!isRecord(scoped) || !Array.isArray(scoped.spans)) continue;
        const scope =
          isRecord(scoped.scope) && typeof scoped.scope.name === "string"
            ? scoped.scope.name
            : undefined;
        for (const rawSpan of scoped.spans) {
          const span = parseSpan(rawSpan, expectedTraceId, scope);
          if (span !== undefined) spans.push(span);
        }
      }
    }
    return spans;
  } catch {
    return [];
  }
}

function parseSpan(
  raw: unknown,
  expectedTraceId: string,
  scope?: string,
): LocalTraceSpan | undefined {
  if (!isRecord(raw)) return undefined;
  if (
    raw.traceId !== expectedTraceId ||
    typeof raw.spanId !== "string" ||
    !/^[0-9a-f]{16}$/u.test(raw.spanId) ||
    typeof raw.name !== "string"
  ) {
    return undefined;
  }
  const startTimeNs = parseNanos(raw.startTimeUnixNano);
  const endTimeNs = parseNanos(raw.endTimeUnixNano);
  if (startTimeNs === undefined || endTimeNs === undefined || endTimeNs < startTimeNs)
    return undefined;
  return {
    attributes: parseAttributes(raw.attributes),
    endTimeNs,
    name: raw.name,
    parentSpanId:
      typeof raw.parentSpanId === "string" && /^[0-9a-f]{16}$/u.test(raw.parentSpanId)
        ? raw.parentSpanId
        : undefined,
    scope,
    spanId: raw.spanId,
    startTimeNs,
    statusCode: parseStatusCode(raw.status),
    traceId: expectedTraceId,
  };
}

function parseAttributes(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return {};
  const attributes: Record<string, unknown> = {};
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.key !== "string" || !isRecord(entry.value)) continue;
    const parsed = parseAnyValue(entry.value);
    if (parsed !== undefined) attributes[entry.key] = parsed;
  }
  return attributes;
}

function parseAnyValue(value: Record<string, unknown>): unknown {
  for (const key of ["stringValue", "boolValue", "intValue", "doubleValue"] as const) {
    if (key in value) return value[key];
  }
  if (isRecord(value.arrayValue) && Array.isArray(value.arrayValue.values)) {
    return value.arrayValue.values.filter(isRecord).map((entry) => parseAnyValue(entry));
  }
  return undefined;
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
  roots.sort(compareSpans);
  for (const siblings of children.values()) siblings.sort(compareSpans);
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
  for (const span of [...spans].sort(compareSpans)) {
    if (!visited.has(span.spanId)) render(span, "", "");
  }
  return lines.join("\n");
}

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
  const details: string[] = [];
  const turnId = stringAttribute(span, "agent.turn.id");
  const stepIndex = valueAttribute(span, "agent.step.index");
  const attempt = valueAttribute(span, "agent.step.attempt");
  const actionKind = stringAttribute(span, "agent.action.kind");
  const actionName = stringAttribute(span, "agent.action.name");
  const model =
    stringAttribute(span, "agent.model.id") ?? stringAttribute(span, "gen_ai.request.model");
  if (span.name === "agent.turn" && turnId !== undefined) {
    details.push(sanitizeForTerminal(turnId));
  }
  if (span.name === "agent.step" && stepIndex !== undefined) {
    details.push(
      `step ${sanitizeForTerminal(String(stepIndex))}${
        attempt === undefined ? "" : `, attempt ${sanitizeForTerminal(String(attempt))}`
      }`,
    );
  }
  if (span.name === "agent.action" && actionName !== undefined) {
    details.push(
      `${sanitizeForTerminal(actionKind ?? "action")}: ${sanitizeForTerminal(actionName)}`,
    );
  }
  if (model !== undefined && span.name.includes("do")) {
    details.push(`model ${sanitizeForTerminal(model)}`);
  }
  const detail = details.length === 0 ? "" : ` [${details.join(", ")}]`;
  const error = span.statusCode === 2 ? " ERROR" : "";
  const recorded = durationMs(span.startTimeNs, span.endTimeNs);
  const elapsed =
    recorded === 0 && extent !== undefined
      ? durationMs(extent.startTimeNs, extent.endTimeNs)
      : recorded;
  return `${sanitizeForTerminal(span.name)}${detail}  ${formatElapsed(elapsed)}${error}`;
}

function compareSpans(left: LocalTraceSpan, right: LocalTraceSpan): number {
  if (left.startTimeNs !== right.startTimeNs) return left.startTimeNs < right.startTimeNs ? -1 : 1;
  if (left.endTimeNs !== right.endTimeNs) return left.endTimeNs < right.endTimeNs ? -1 : 1;
  return left.name.localeCompare(right.name) || left.spanId.localeCompare(right.spanId);
}

function firstNumberAttribute(
  attributes: readonly Readonly<Record<string, unknown>>[],
  key: string,
): number | undefined {
  for (const values of attributes) {
    const value = values[key];
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
  }
  return undefined;
}

function distinctAttributes(
  attributes: readonly Readonly<Record<string, unknown>>[],
  key: string,
): readonly string[] {
  const values = new Set<string>();
  for (const entry of attributes) {
    const value = entry[key];
    if (typeof value === "string" && value.length > 0) values.add(value);
  }
  return [...values];
}

function firstAttribute(
  attributes: readonly Readonly<Record<string, unknown>>[],
  key: string,
): string | undefined {
  for (const values of attributes) {
    const value = values[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function stringAttribute(span: LocalTraceSpan, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === "string" ? value : undefined;
}

function valueAttribute(span: LocalTraceSpan, key: string): string | number | undefined {
  const value = span.attributes[key];
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function parseNanos(value: unknown): bigint | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= MAX_UINT64 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseStatusCode(value: unknown): number {
  if (!isRecord(value)) return 0;
  if (typeof value.code === "number") return value.code;
  return value.code === "STATUS_CODE_ERROR" ? 2 : 0;
}

function durationMs(start: bigint, end: bigint): number {
  return Number(end - start) / 1_000_000;
}

function toDate(nanoseconds: bigint): Date {
  return new Date(Number(nanoseconds / 1_000_000n));
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
