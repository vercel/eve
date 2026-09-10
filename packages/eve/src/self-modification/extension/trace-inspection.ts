import type { ToolContext } from "eve/tools";

import type { LocalTraceSpanSource } from "#self-modification/local-trace-analysis.js";
import { parseLocalTraceSegment } from "#tracing/local-trace-reader.js";

export const TRACE_ID = /^[0-9a-f]{32}$/u;
export const SPAN_ID = /^[0-9a-f]{16}$/u;

const SEGMENT_FILE = /^[0-9a-f]{16}\.otlp\.json$/u;
const MAX_SEGMENTS = 500;
const MAX_SEGMENT_BYTES = 8 * 1024 * 1024;

export async function readTraceSources(
  traceId: string,
  ctx: Pick<ToolContext, "abortSignal" | "getSandbox">,
): Promise<LocalTraceSpanSource[]> {
  const sandbox = await ctx.getSandbox();
  const directory = `/traces/${traceId}/segments`;
  const listed = await sandbox.run({ command: `ls -1 ${directory}` });
  if (listed.exitCode !== 0) {
    throw new Error(`Could not list local trace segments: ${listed.stderr}`);
  }
  const files = listed.stdout
    .split(/\r?\n/u)
    .filter((name) => SEGMENT_FILE.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (files.length > MAX_SEGMENTS) {
    throw new Error(`Trace has ${files.length} segments (maximum ${MAX_SEGMENTS}).`);
  }

  const sources: LocalTraceSpanSource[] = [];
  for (const file of files) {
    if (ctx.abortSignal.aborted) throw new Error("Trace inspection was cancelled.");
    const content = await sandbox.readTextFile({ path: `${directory}/${file}` });
    if (content === null || content.length > MAX_SEGMENT_BYTES) continue;
    for (const span of parseLocalTraceSegment(content, traceId)) {
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
