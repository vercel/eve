import { formatCompactTokenCount } from "#cli/dev/tui/stream-format.js";
import { formatAttributeContent } from "#cli/dev/tui/traces/trace-content.js";
import { formatElapsed } from "#cli/format-elapsed.js";
import { sanitizeForTerminal } from "#cli/ui/output.js";
import type { LocalTraceSpan } from "#tracing/local/trace-reader.js";
import { localTraceSpanCostUsd, type LocalTraceSummary } from "#tracing/local/trace-summary.js";

export function spanMetricChips(span: LocalTraceSpan): string[] {
  const chips: string[] = [];
  const operation = span.attributes["gen_ai.operation.name"];
  const usagePrefix =
    operation === "chat" || operation === "invoke_agent" ? "gen_ai.usage" : "agent.usage";
  const input = numberAttribute(span, `${usagePrefix}.input_tokens`);
  const output = numberAttribute(span, `${usagePrefix}.output_tokens`);
  if (input !== undefined) chips.push(`↑${formatCompactTokenCount(input)}`);
  if (output !== undefined) chips.push(`↓${formatCompactTokenCount(output)}`);
  const cost = localTraceSpanCostUsd(span);
  if (cost !== undefined) chips.push(formatCostUsd(cost));
  return chips;
}

export function formatTokenSummary(
  summary: Pick<
    LocalTraceSummary,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
  >,
): string {
  const parts = [
    `↑${formatCompactTokenCount(summary.inputTokens)} in`,
    `↓${formatCompactTokenCount(summary.outputTokens)} out`,
  ];
  if (summary.cacheReadTokens > 0)
    parts.push(`${formatCompactTokenCount(summary.cacheReadTokens)} cached`);
  if (summary.cacheWriteTokens > 0)
    parts.push(`${formatCompactTokenCount(summary.cacheWriteTokens)} cache write`);
  return parts.join(" · ");
}

export function formatCostUsd(costUsd: number): string {
  return costUsd >= 1 ? `$${costUsd.toFixed(2)}` : `$${costUsd.toFixed(4)}`;
}

export function renderSpanDetailTree(
  span: LocalTraceSpan,
  options: {
    readonly childrenFollow: boolean;
    readonly margin: string;
    readonly mute: (text: string) => string;
    readonly width: number;
  },
): string[] {
  const entries = spanDetailEntries(span, options.width - options.margin.length - 3);
  const lines: string[] = [];
  entries.forEach((entry, index) => {
    const last = index === entries.length - 1 && !options.childrenFollow;
    emit(entry, options.margin, last ? "└─ " : "├─ ");
  });
  return lines;

  function emit(entry: SpanDetailEntry, margin: string, connector: string): void {
    lines.push(options.mute(`${margin}${connector}${entry.head}`));
    const childMargin = `${margin}${connector === "└─ " ? "   " : "│  "}`;
    for (const line of entry.lines) lines.push(options.mute(`${childMargin}  ${line}`));
    entry.entries.forEach((nested, index) => {
      emit(nested, childMargin, index === entry.entries.length - 1 ? "└─ " : "├─ ");
    });
  }
}

interface SpanDetailEntry {
  readonly head: string;
  readonly lines: readonly string[];
  readonly entries: readonly SpanDetailEntry[];
}

function spanDetailEntries(span: LocalTraceSpan, width: number): SpanDetailEntry[] {
  const dim = (text: string): string => text;
  const attrWidth = Math.max(40, width);
  const entries: SpanDetailEntry[] = [];
  const push = (
    head: string,
    lines: readonly string[] = [],
    nested: readonly SpanDetailEntry[] = [],
  ): void => {
    entries.push({ entries: nested, head, lines });
  };
  const error = span.statusCode === 2;
  const status =
    error && span.statusMessage !== undefined
      ? `ERROR — ${sanitizeForTerminal(span.statusMessage)}`
      : error
        ? "ERROR"
        : "ok";
  push(`status: ${status}`);
  push(`duration: ${formatElapsed(durationMs(span.startTimeNs, span.endTimeNs))}`);
  push(`started: ${new Date(Number(span.startTimeNs / 1_000_000n)).toISOString()}`);
  push(`span: ${span.spanId}`);
  if (span.parentSpanId !== undefined) push(`parent: ${span.parentSpanId}`);
  if (span.scope !== undefined) push(`scope: ${sanitizeForTerminal(span.scope)}`);
  if (span.kind !== undefined && span.kind !== 1) push(`kind: ${spanKind(span.kind)}`);

  for (const key of Object.keys(span.attributes).sort()) {
    const block = formatAttributeContent(key, span.attributes[key], dim, attrWidth - 2);
    const cleanKey = sanitizeForTerminal(key);
    if (block.length === 1) {
      push(`${cleanKey}: ${block[0]}`);
    } else {
      push(`${cleanKey}:`, block);
    }
  }

  if (span.events.length > 0) {
    push(
      "events:",
      [],
      span.events.map((event) => {
        const offsetMs = Math.max(0, durationMs(span.startTimeNs, event.timeNs));
        const lines: string[] = [];
        for (const key of Object.keys(event.attributes).sort()) {
          const block = formatAttributeContent(key, event.attributes[key], dim, attrWidth - 6);
          const cleanKey = sanitizeForTerminal(key);
          if (block.length === 1) {
            lines.push(`${cleanKey}: ${block[0]}`);
          } else {
            lines.push(`${cleanKey}:`, ...block.map((line) => `  ${line}`));
          }
        }
        return {
          entries: [],
          head: `${sanitizeForTerminal(event.name)}  +${formatElapsed(offsetMs)}`,
          lines,
        };
      }),
    );
  }
  return entries;
}

function spanKind(kind: number): string {
  switch (kind) {
    case 2:
      return "server";
    case 3:
      return "client";
    case 4:
      return "producer";
    case 5:
      return "consumer";
    default:
      return `unknown (${kind})`;
  }
}

function numberAttribute(span: LocalTraceSpan, key: string): number | undefined {
  const value = span.attributes[key];
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function durationMs(start: bigint, end: bigint): number {
  return Number(end - start) / 1_000_000;
}
