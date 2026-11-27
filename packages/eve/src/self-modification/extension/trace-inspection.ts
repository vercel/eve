import { getLocalDevCapability } from "eve/local-dev";
import type { ToolContext } from "eve/tools";

import {
  listLocalTraceSegments,
  readLocalTraceSegment,
  type LocalTraceSpan,
} from "#tracing/local/trace-reader.js";

export interface LocalTraceSpanSource {
  readonly segmentFile: string;
  readonly span: LocalTraceSpan;
}

export const TRACE_ID = /^[0-9a-f]{32}$/u;
export const SPAN_ID = /^[0-9a-f]{16}$/u;

const MAX_SEGMENTS = 500;

export function requireLocalTraceAppRoot(): string {
  const capability = getLocalDevCapability();
  if (capability === undefined) {
    throw new Error("Local trace inspection requires eve dev facilities.");
  }
  return capability.appRoot;
}

export async function readTraceSources(
  traceId: string,
  ctx: Pick<ToolContext, "abortSignal">,
): Promise<LocalTraceSpanSource[]> {
  const appRoot = requireLocalTraceAppRoot();
  const files = await listLocalTraceSegments(appRoot, traceId);
  if (files === undefined) {
    throw new Error(`Could not list local trace segments for ${traceId}.`);
  }
  if (files.length > MAX_SEGMENTS) {
    throw new Error(`Trace has ${files.length} segments (maximum ${MAX_SEGMENTS}).`);
  }

  const sources: LocalTraceSpanSource[] = [];
  for (const file of files) {
    if (ctx.abortSignal.aborted) throw new Error("Trace inspection was cancelled.");
    for (const span of await readLocalTraceSegment(appRoot, traceId, file)) {
      sources.push({ segmentFile: file, span });
    }
  }
  return sources;
}

export function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

export function detailFields(source: LocalTraceSpanSource): {
  readonly arguments: unknown;
  readonly error: string | undefined;
  readonly result: unknown;
} {
  return {
    arguments: source.span.attributes["gen_ai.tool.call.arguments"],
    error: source.span.statusMessage,
    result: source.span.attributes["gen_ai.tool.call.result"],
  };
}
