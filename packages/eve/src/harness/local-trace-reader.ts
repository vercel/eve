/**
 * Reads the local trace spool written by {@link LocalTraceSpanProcessor}.
 *
 * The spool is the contract between the dev-time writer and every viewer
 * (`eve traces`, the TUI trace viewer): one directory per trace under
 * `.eve/traces/v1/<traceId>/segments/`, one immutable OTLP/JSON file per
 * span. Parsing is defensive end to end — malformed or oversized segments
 * are skipped so a partial write never breaks a view.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  resolveLocalTraceSchemaDirectory,
  resolveLocalTraceSegmentsDirectory,
} from "#harness/local-trace-span-processor.js";

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const SPAN_FILE_PATTERN = /^[0-9a-f]{16}\.otlp\.json$/u;
const MAX_SEGMENT_BYTES = 8 * 1024 * 1024;
const MAX_UINT64 = 18_446_744_073_709_551_615n;

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

export interface LocalTrace {
  readonly agentName?: string;
  readonly endTimeNs: bigint;
  /** Session that opened the trace, which is the one the list shows. */
  readonly sessionId?: string;
  /**
   * Every session recorded in the trace, opener first.
   *
   * A subagent child records into the window its parent had open, so one
   * trace can hold several sessions and any of their ids resolves to it.
   */
  readonly sessionIds: readonly string[];
  readonly spans: readonly LocalTraceSpan[];
  readonly startTimeNs: bigint;
  readonly traceId: string;
  /** Zero-based session window this trace holds, when the spans record one. */
  readonly window?: number;
}

/**
 * Trace ids held by the spool, unordered. Empty when nothing has been written
 * yet; any other read fault propagates.
 */
export async function listLocalTraceIds(appRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(resolveLocalTraceSchemaDirectory(appRoot), { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && TRACE_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name);
}

/**
 * Instant one trace last received a span, or `undefined` once retention has
 * pruned it. Reads the segments directory's mtime, so it stays cheap enough to
 * poll a large spool without parsing any span.
 */
export async function readLocalTraceActivityMs(
  appRoot: string,
  traceId: string,
): Promise<number | undefined> {
  try {
    return (await stat(resolveLocalTraceSegmentsDirectory(appRoot, traceId))).mtimeMs;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/**
 * Segment file names of one trace in read order, or `undefined` when the trace
 * is gone. Segments are immutable and named for their span, so the order is
 * stable across reads and a caller can treat names it has seen as parsed.
 */
export async function listLocalTraceSegments(
  appRoot: string,
  traceId: string,
): Promise<string[] | undefined> {
  let entries;
  try {
    entries = await readdir(resolveLocalTraceSegmentsDirectory(appRoot, traceId), {
      withFileTypes: true,
    });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && SPAN_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Spans held by one segment file. An oversized, unreadable, or malformed
 * segment yields none, so a partial write never breaks a view.
 */
export async function readLocalTraceSegment(
  appRoot: string,
  traceId: string,
  fileName: string,
): Promise<LocalTraceSpan[]> {
  const path = join(resolveLocalTraceSegmentsDirectory(appRoot, traceId), fileName);
  let content: string;
  try {
    if ((await stat(path)).size > MAX_SEGMENT_BYTES) return [];
    content = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return parseLocalTraceSegment(content, traceId);
}

/** Reads valid local traces, newest first, while ignoring malformed segments. */
export async function listLocalTraces(appRoot: string): Promise<LocalTrace[]> {
  const traces: LocalTrace[] = [];
  for (const traceId of await listLocalTraceIds(appRoot)) {
    const trace = await readLocalTrace(appRoot, traceId).catch(() => undefined);
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
 * Reads one whole trace, or `undefined` when it holds no valid spans. Spans
 * come back ordered by start time.
 */
async function readLocalTrace(appRoot: string, traceId: string): Promise<LocalTrace | undefined> {
  const fileNames = await listLocalTraceSegments(appRoot, traceId);
  if (fileNames === undefined) return undefined;
  const spans = new Map<string, LocalTraceSpan>();
  for (const fileName of fileNames) {
    for (const span of await readLocalTraceSegment(appRoot, traceId, fileName)) {
      if (!spans.has(span.spanId)) spans.set(span.spanId, span);
    }
  }
  if (spans.size === 0) return undefined;
  return assembleLocalTrace(traceId, [...spans.values()]);
}

/** Sorts spans into timeline order: start, then end, then a stable tiebreak. */
export function compareLocalTraceSpans(left: LocalTraceSpan, right: LocalTraceSpan): number {
  if (left.startTimeNs !== right.startTimeNs) return left.startTimeNs < right.startTimeNs ? -1 : 1;
  if (left.endTimeNs !== right.endTimeNs) return left.endTimeNs < right.endTimeNs ? -1 : 1;
  return left.name.localeCompare(right.name) || left.spanId.localeCompare(right.spanId);
}

/** Builds a trace from already-parsed spans, deriving summary fields. */
export function assembleLocalTrace(traceId: string, spans: readonly LocalTraceSpan[]): LocalTrace {
  const ordered = [...spans].sort(compareLocalTraceSpans);
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

/**
 * Extracts short human-facing details from a span's structural attributes
 * (turn id, step index/attempt, action kind/name, model id) for one-line
 * span labels. Raw values — callers sanitize for their output surface.
 */
export function describeLocalTraceSpan(span: LocalTraceSpan): string[] {
  const details: string[] = [];
  const turnId = stringSpanAttribute(span, "agent.turn.id");
  const stepIndex = valueSpanAttribute(span, "agent.step.index");
  const attempt = valueSpanAttribute(span, "agent.step.attempt");
  const actionKind = stringSpanAttribute(span, "agent.action.kind");
  const actionName = stringSpanAttribute(span, "agent.action.name");
  const model =
    stringSpanAttribute(span, "agent.model.id") ??
    stringSpanAttribute(span, "gen_ai.request.model");
  if (span.name === "agent.turn" && turnId !== undefined) {
    details.push(turnId);
  }
  if (span.name === "agent.step" && stepIndex !== undefined) {
    details.push(
      `step ${String(stepIndex)}${attempt === undefined ? "" : `, attempt ${String(attempt)}`}`,
    );
  }
  if (span.name === "agent.action" && actionName !== undefined) {
    details.push(`${actionKind ?? "action"}: ${actionName}`);
  }
  if (model !== undefined && span.name.includes("do")) {
    details.push(`model ${model}`);
  }
  return details;
}

/** Parses one OTLP/JSON segment file into spans belonging to `expectedTraceId`. */
export function parseLocalTraceSegment(content: string, expectedTraceId: string): LocalTraceSpan[] {
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
          const span = parseLocalTraceSpan(rawSpan, expectedTraceId, scope);
          if (span !== undefined) spans.push(span);
        }
      }
    }
    return spans;
  } catch {
    return [];
  }
}

function parseLocalTraceSpan(
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

function stringSpanAttribute(span: LocalTraceSpan, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === "string" ? value : undefined;
}

function valueSpanAttribute(span: LocalTraceSpan, key: string): string | number | undefined {
  const value = span.attributes[key];
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
