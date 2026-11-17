import { formatCostUsd } from "#cli/commands/trace-detail.js";
import { formatElapsed } from "#cli/format-elapsed.js";
import { clipVisible, stripTerminalControls, visibleLength } from "#cli/ui/terminal-text.js";
import type { LocalTrace, LocalTraceSpan } from "#tracing/local/trace-reader.js";
import { compareLocalTraceSpans, isAgentTurnSpan } from "#tracing/local/trace-reader.js";
import { agentTurnIdentity } from "#tracing/local/inspection.js";
import { localTraceSpanCostUsd } from "#tracing/local/trace-summary.js";
import { traceStringAttribute } from "#tracing/local/trace-operations.js";

import { formatCompactTokenCount } from "../stream-format.js";
import type { Theme } from "../theme.js";
import { formatPayloadContent, wrapPlainText } from "./trace-content.js";
import type { TraceViewerSurfaces } from "./trace-surfaces.js";
import { SURFACE_CLOSE } from "./trace-surfaces.js";

export interface ConversationItem {
  readonly kind: "system" | "user" | "assistant" | "tool";
  readonly span: LocalTraceSpan;
  readonly name?: string;
  readonly text?: string;
  readonly reasoning?: string;
  readonly toolCallNames?: readonly string[];
  readonly args?: string;
  readonly result?: string;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly subagent?: ConversationSubagent;
  readonly durationMs: number;
  readonly error: boolean;
}

export interface ConversationSubagent {
  readonly name?: string;
  readonly parentTurnId?: string;
  readonly parentCallId?: string;
}

const CARD_PAYLOAD_LINES = 3;

export function buildConversationItems(trace: LocalTrace): ConversationItem[] {
  const byId = new Map(trace.spans.map((span) => [span.spanId, span]));
  const subagents = new Map<string, ConversationSubagent>();
  for (const span of trace.spans) {
    if (!isAgentTurnSpan(span)) continue;
    const turnId = agentTurnIdentity(span);
    const subagent = turnSubagent(span, byId);
    if (turnId !== undefined && subagent !== undefined) subagents.set(turnId, subagent);
  }
  const entries: { readonly item: ConversationItem; readonly order: bigint }[] = [];
  let system: { readonly span: LocalTraceSpan; readonly text: string } | undefined;
  for (const span of [...trace.spans].sort(compareLocalTraceSpans)) {
    const text = isModelSpan(span) ? systemInstructionsText(span.attributes) : undefined;
    if (text !== undefined) {
      system = { span, text };
      break;
    }
  }
  if (system !== undefined) {
    entries.push({
      item: {
        kind: "system",
        durationMs: 0,
        error: false,
        span: system.span,
        subagent: subagentFor(system.span, subagents, byId),
        text: system.text,
      },
      order: 0n,
    });
  }

  for (const span of trace.spans) {
    const subagent = subagentFor(span, subagents, byId);
    const deliveryInput = stringAttribute(span, "agent.channel.delivery.input");
    if (deliveryInput !== undefined) {
      const text = deliveryText(deliveryInput);
      if (text === undefined) continue;
      entries.push({
        item: {
          kind: "user",
          durationMs: 0,
          error: false,
          span,
          subagent,
          text,
        },
        order: span.startTimeNs,
      });
      continue;
    }
    if (isModelSpan(span)) {
      const text = stringAttribute(span, "ai.response.text");
      const reasoning = stringAttribute(span, "ai.response.reasoning");
      const inputTokens = numberAttribute(span, "gen_ai.usage.input_tokens");
      const outputTokens = numberAttribute(span, "gen_ai.usage.output_tokens");
      const hasUsage = inputTokens !== undefined || outputTokens !== undefined;
      const hasToolCalls = span.attributes["ai.response.tool_calls"] !== undefined;
      const isEmpty =
        (text === undefined || text.trim().length === 0) &&
        (reasoning === undefined || reasoning.trim().length === 0) &&
        !hasUsage &&
        !hasToolCalls &&
        span.statusCode !== 2;
      if (isEmpty) continue;
      entries.push({
        item: {
          kind: "assistant",
          costUsd: stepCostUsd(span, byId),
          durationMs: spanDurationMs(span),
          error: span.statusCode === 2,
          inputTokens,
          model: stringAttribute(span, "gen_ai.request.model"),
          outputTokens,
          reasoning,
          span,
          subagent,
          text,
          toolCallNames: hasToolCalls
            ? parseToolCallNames(stringAttribute(span, "ai.response.tool_calls"))
            : undefined,
        },
        order: span.startTimeNs,
      });
      for (const result of parseProviderToolResults(
        stringAttribute(span, "ai.response.tool_results"),
      )) {
        entries.push({
          item: {
            kind: "tool",
            args: result.args,
            durationMs: 0,
            error: result.error,
            name: stripTerminalControls(result.name),
            result: result.result,
            span,
            subagent,
          },
          order: span.startTimeNs,
        });
      }
      continue;
    }
    if (
      span.attributes["gen_ai.operation.name"] === "execute_tool" ||
      span.name === "agent.action"
    ) {
      entries.push({
        item: {
          kind: "tool",
          args: stringAttribute(span, "gen_ai.tool.call.arguments"),
          durationMs: spanDurationMs(span),
          error: span.statusCode === 2,
          name: stripTerminalControls(
            stringAttribute(span, "gen_ai.tool.name") ??
              stringAttribute(span, "agent.action.name") ??
              "tool",
          ),
          result: unwrapJsonString(stringAttribute(span, "gen_ai.tool.call.result")),
          span,
          subagent,
        },
        order: span.startTimeNs,
      });
    }
  }
  return entries
    .sort((left, right) => (left.order === right.order ? 0 : left.order < right.order ? -1 : 1))
    .map((entry) => entry.item);
}

function systemInstructionsText(attributes: Readonly<Record<string, unknown>>): string | undefined {
  const value = attributes["gen_ai.system_instructions"];
  if (typeof value !== "string") return undefined;
  try {
    const instructions: unknown = JSON.parse(value);
    if (!Array.isArray(instructions)) return undefined;
    const text = instructions
      .flatMap((instruction: unknown) => {
        if (
          typeof instruction !== "object" ||
          instruction === null ||
          !("type" in instruction) ||
          instruction.type !== "text" ||
          !("content" in instruction) ||
          typeof instruction.content !== "string"
        )
          return [];
        return [instruction.content];
      })
      .join("\n\n");
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

function subagentFor(
  span: LocalTraceSpan,
  subagents: ReadonlyMap<string, ConversationSubagent>,
  byId: ReadonlyMap<string, LocalTraceSpan>,
): ConversationSubagent | undefined {
  let current: LocalTraceSpan | undefined = span;
  while (current !== undefined) {
    const turnId = agentTurnIdentity(current);
    if (turnId !== undefined) return subagents.get(turnId);
    current = current.parentSpanId === undefined ? undefined : byId.get(current.parentSpanId);
  }
  return undefined;
}

function turnSubagent(
  turn: LocalTraceSpan,
  byId: ReadonlyMap<string, LocalTraceSpan>,
): ConversationSubagent | undefined {
  const subagentName = stringAttribute(turn, "agent.subagent.name");
  if (subagentName !== undefined) {
    const name = subagentName ?? stringAttribute(turn, "gen_ai.agent.name");
    return {
      name: name === undefined ? undefined : stripTerminalControls(name),
    };
  }
  const parent = turn.parentSpanId === undefined ? undefined : byId.get(turn.parentSpanId);
  if (parent === undefined) return undefined;
  const kind = stringAttribute(parent, "agent.action.kind");
  if (kind !== "subagent-call" && kind !== "remote-agent-call") return undefined;
  const parentTurnId = stringAttribute(parent, "agent.turn.id");
  if (parentTurnId === undefined) return undefined;
  const name = stringAttribute(parent, "agent.action.name");
  return {
    name: name === undefined ? undefined : stripTerminalControls(name),
    parentCallId: traceStringAttribute(parent, "gen_ai.tool.call.id"),
    parentTurnId,
  };
}

export function renderConversationItem(
  item: ConversationItem,
  width: number,
  theme: Theme,
  selected: boolean,
  expanded: boolean,
  surfaces?: TraceViewerSurfaces,
): string[] {
  const { colors, glyph } = theme;
  const inner = Math.max(8, width - 8);
  const expandable = conversationItemExpandable(item, width);
  const active = theme.color ? surfaces : undefined;
  const primary = active?.primaryText ?? colors.white;

  let leftTitle: string;
  let rightTitle: string;
  const body: string[] = [];
  if (item.kind === "tool") {
    const name = colors.bold(primary(item.name ?? "tool"));
    leftTitle = `${foldMarker(expanded, expandable, theme)}${name}`;
    rightTitle = item.durationMs > 0 ? colors.dim(formatElapsed(item.durationMs)) : "";
    const argsLines = item.args === undefined ? [] : formatPayloadContent(item.args, inner);
    const resultLines = item.result === undefined ? [] : formatPayloadContent(item.result, inner);
    const cappedArgs = expanded ? argsLines : capLines(argsLines, inner);
    const cappedResult = expanded ? resultLines : capLines(resultLines, inner);
    if (cappedArgs.length > 0) {
      body.push("", colors.dim("Input:"), "", ...cappedArgs);
    }
    if (cappedResult.length > 0) {
      body.push("", colors.dim("Output:"), "", ...cappedResult);
    }
  } else if (item.kind === "system") {
    leftTitle = `${foldMarker(expanded, expandable, theme)}${colors.bold(primary("system"))}`;
    rightTitle = colors.dim(`~${formatCompactTokenCount(estimateTokens(item.text ?? ""))} tokens`);
    const uncapped = wrapPlainText(item.text ?? "", inner);
    body.push(...(expanded ? uncapped : capLines(uncapped, inner)));
  } else if (item.kind === "assistant") {
    leftTitle = `${foldMarker(expanded, expandable, theme)}${colors.bold(primary("assistant"))}${
      item.model !== undefined ? colors.dim(` · ${stripTerminalControls(item.model)}`) : ""
    }`;
    rightTitle = assistantMetrics(item, glyph, colors);
    const reasoningUncapped =
      item.reasoning === undefined || item.reasoning.trim().length === 0
        ? []
        : wrapPlainText(item.reasoning, inner);
    const textUncapped =
      item.text === undefined || item.text.trim().length === 0
        ? []
        : wrapPlainText(item.text, inner);
    const reasoningLines = (expanded ? reasoningUncapped : capLines(reasoningUncapped, inner)).map(
      (line) => colors.dim(line),
    );
    const textLines = expanded ? textUncapped : capLines(textUncapped, inner);
    if (reasoningLines.length > 0) {
      body.push(colors.dim("Thought:"), "", ...reasoningLines);
      if (textLines.length > 0) body.push("");
    }
    body.push(...textLines);
    if (
      (item.text === undefined || item.text.trim().length === 0) &&
      item.toolCallNames !== undefined &&
      item.toolCallNames.length > 0
    ) {
      if (reasoningLines.length > 0) body.push("");
      for (const name of item.toolCallNames) {
        body.push(colors.dim(`→ ${name}`));
      }
    }
  } else {
    const label = item.kind === "user" && item.subagent !== undefined ? "task" : item.kind;
    leftTitle = `${foldMarker(expanded, expandable, theme)}${colors.bold(primary(label))}`;
    rightTitle = "";
    const textUncapped =
      item.text === undefined || item.text.trim().length === 0
        ? []
        : wrapPlainText(item.text, inner);
    body.push(...(expanded ? textUncapped : capLines(textUncapped, inner)));
  }
  if (item.subagent !== undefined) {
    const label = item.subagent.name === undefined ? "subagent" : `subagent:${item.subagent.name}`;
    leftTitle += colors.dim(` · ${label}`);
  }
  if (item.error) leftTitle += ` ${colors.red(glyph.error)}`;
  if (!expanded && expandable) {
    body.push("…", "", colors.dim("Click to expand"));
  } else if (expanded && expandable) {
    body.push("", colors.dim("Click to collapse"));
  }

  const headerSurface =
    active === undefined ? undefined : item.error ? active.errorHeader : active.header;
  const bodySurface =
    active === undefined ? undefined : item.error ? active.errorBody : active.body;
  const rail = railCell(theme, selected, item.error, active);
  return [
    cardRow("", width, theme, rail, headerSurface),
    cardSplitRow(leftTitle, rightTitle, width, theme, rail, headerSurface),
    cardRow("", width, theme, rail, headerSurface),
    cardRow("", width, theme, rail, bodySurface),
    ...body.map((line) => cardRow(line, width, theme, rail, bodySurface)),
    cardRow("", width, theme, rail, bodySurface),
  ];
}

function cardRow(
  line: string,
  width: number,
  theme: Theme,
  rail: string,
  surface?: string,
): string {
  const clipped = clipVisible(line, Math.max(1, width - 8));
  const pad = " ".repeat(Math.max(0, width - 8 - visibleLength(clipped)));
  if (surface === undefined || !theme.color) return ` ${rail}  ${clipped}${pad}    `;
  const covered = clipped.replaceAll("\x1b[0m", `\x1b[0m${surface}`);
  return ` ${rail}${surface}  ${covered}\x1b[0m${surface}${pad}  ${SURFACE_CLOSE}  `;
}

function railCell(
  theme: Theme,
  selected: boolean,
  error: boolean,
  surfaces: TraceViewerSurfaces | undefined,
): string {
  const { colors, glyph } = theme;
  if (selected) {
    const bar = theme.unicode ? "▌" : glyph.rule;
    return surfaces === undefined ? colors.white(bar) : surfaces.primaryText(bar);
  }
  if (surfaces !== undefined) return " ";
  return error ? colors.red(glyph.rule) : colors.dim(glyph.rule);
}

function cardSplitRow(
  left: string,
  right: string,
  width: number,
  theme: Theme,
  rail: string,
  surface?: string,
): string {
  if (visibleLength(right) === 0) return cardRow(left, width, theme, rail, surface);
  const inner = Math.max(1, width - 8);
  const rightVis = visibleLength(right);
  const leftMax = Math.max(1, inner - rightVis - 2);
  const leftClipped = clipVisible(left, leftMax);
  const gap = " ".repeat(Math.max(2, inner - visibleLength(leftClipped) - rightVis));
  return cardRow(`${leftClipped}${gap}${right}`, width, theme, rail, surface);
}

function assistantMetrics(
  item: ConversationItem,
  glyph: Theme["glyph"],
  colors: Theme["colors"],
): string {
  const parts: string[] = [];
  if (item.durationMs > 0) parts.push(formatElapsed(item.durationMs));
  if (item.inputTokens !== undefined)
    parts.push(`${glyph.arrowUp}${formatCompactTokenCount(item.inputTokens)}`);
  if (item.outputTokens !== undefined)
    parts.push(`${glyph.arrowDown}${formatCompactTokenCount(item.outputTokens)}`);
  if (item.costUsd !== undefined) parts.push(formatCostUsd(item.costUsd));
  return parts.length === 0 ? "" : colors.dim(parts.join(" · "));
}

function stepCostUsd(
  modelSpan: LocalTraceSpan,
  byId: Map<string, LocalTraceSpan>,
): number | undefined {
  let span: LocalTraceSpan | undefined = modelSpan;
  while (span.parentSpanId !== undefined) {
    span = byId.get(span.parentSpanId);
    if (span === undefined) return undefined;
    if (span.name === "agent.step") return localTraceSpanCostUsd(span);
  }
  return undefined;
}

function foldMarker(expanded: boolean, expandable: boolean, theme: Theme): string {
  if (expanded) return `${theme.colors.dim("▾")} `;
  return expandable ? `${theme.colors.dim("▸")} ` : "";
}

function capLines(lines: readonly string[], width: number): string[] {
  if (lines.length <= CARD_PAYLOAD_LINES) return [...lines];
  return [
    ...lines.slice(0, CARD_PAYLOAD_LINES - 1),
    clipVisible(lines[CARD_PAYLOAD_LINES - 1]!, Math.max(1, width)),
  ];
}

export function conversationItemLineCount(
  item: ConversationItem,
  width: number,
  theme: Theme,
  expanded: boolean,
): number {
  return renderConversationItem(item, width, theme, false, expanded).length;
}

export function conversationItemExpandable(item: ConversationItem, width: number): boolean {
  const inner = Math.max(8, width - 8);
  if (item.kind === "tool") {
    const args = item.args === undefined ? 0 : formatPayloadContent(item.args, inner - 2).length;
    const result =
      item.result === undefined ? 0 : formatPayloadContent(item.result, inner - 2).length;
    return args > CARD_PAYLOAD_LINES || result > CARD_PAYLOAD_LINES;
  }
  if (item.kind === "system")
    return wrapPlainText(item.text ?? "", inner).length > CARD_PAYLOAD_LINES;
  if (item.kind === "user") {
    const text =
      item.text === undefined || item.text.trim().length === 0
        ? 0
        : wrapPlainText(item.text, inner).length;
    return text > CARD_PAYLOAD_LINES;
  }
  const reasoning =
    item.reasoning === undefined || item.reasoning.trim().length === 0
      ? 0
      : wrapPlainText(item.reasoning, inner).length;
  const text =
    item.text === undefined || item.text.trim().length === 0
      ? 0
      : wrapPlainText(item.text, inner).length;
  return reasoning > CARD_PAYLOAD_LINES || text > CARD_PAYLOAD_LINES;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function deliveryText(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const input: unknown = JSON.parse(raw);
    if (isRecord(input) && typeof input.message === "string") return input.message;
    return undefined;
  } catch {
    return raw;
  }
}

function unwrapJsonString(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : raw;
  } catch {
    return raw;
  }
}

function isModelSpan(span: LocalTraceSpan): boolean {
  return (
    (span.name.startsWith("ai.") && span.name.includes("do")) ||
    span.attributes["gen_ai.operation.name"] === "chat"
  );
}

function parseToolCallNames(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    return parsed
      .filter(
        (entry): entry is { toolName: string } =>
          isRecord(entry) && typeof entry.toolName === "string",
      )
      .map((entry) => entry.toolName);
  } catch {
    return undefined;
  }
}

interface ProviderToolResult {
  readonly args: string | undefined;
  readonly error: boolean;
  readonly name: string;
  readonly result: string | undefined;
}

function parseProviderToolResults(raw: string | undefined): readonly ProviderToolResult[] {
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const asText = (value: unknown): string | undefined =>
      typeof value === "string" ? value : value === undefined ? undefined : JSON.stringify(value);
    return parsed.filter(isRecord).map((entry) => {
      const failed = "error" in entry;
      return {
        args: asText(entry.input),
        error: failed,
        name: typeof entry.toolName === "string" ? entry.toolName : "tool",
        result: asText(failed ? entry.error : entry.output),
      };
    });
  } catch {
    return [];
  }
}

function stringAttribute(span: LocalTraceSpan, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === "string" ? value : undefined;
}

function numberAttribute(span: LocalTraceSpan, key: string): number | undefined {
  const value = span.attributes[key];
  return typeof value === "number" ? value : undefined;
}

function spanDurationMs(span: LocalTraceSpan): number {
  return Math.max(0, Number(span.endTimeNs - span.startTimeNs) / 1_000_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
