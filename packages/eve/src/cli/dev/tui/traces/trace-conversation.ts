/**
 * Conversation view for the `/traces` viewer: the same trace, re-told as a
 * flow of user messages, assistant replies, and tool calls instead of a
 * latency waterfall. Items are built from the span tree (turns in order,
 * subtrees in time order) with text pulled from the content attributes —
 * the user's message from the turn's first model prompt, replies and tool
 * calls from response/tool spans.
 */

import { formatElapsed } from "#cli/format-elapsed.js";
import { clipVisible, stripTerminalControls, visibleLength } from "#cli/ui/terminal-text.js";
import type { LocalTrace, LocalTraceSpan } from "#tracing/local-trace-reader.js";
import { compareLocalTraceSpans } from "#tracing/local-trace-reader.js";

import { formatCompactTokenCount } from "../stream-format.js";
import type { Theme } from "../theme.js";
import { formatPayloadContent, wrapPlainText } from "./trace-content.js";
import type { TraceViewerSurfaces } from "./trace-surfaces.js";
import { SURFACE_CLOSE } from "./trace-surfaces.js";

export interface ConversationItem {
  readonly kind: "system" | "user" | "assistant" | "tool";
  /** Detail-drawer source for this item (the turn marker span for users). */
  readonly span: LocalTraceSpan;
  /** Tool name for tool items. */
  readonly name?: string;
  /** Message text for system/user/assistant items. */
  readonly text?: string;
  /** Model reasoning for assistant items (shown dim above the reply). */
  readonly reasoning?: string;
  /** Tool names from the model's tool-call decision (shown when no text). */
  readonly toolCallNames?: readonly string[];
  /** Raw JSON for tool input / output. */
  readonly args?: string;
  readonly result?: string;
  /** Assistant card metadata. */
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** Gateway-reported inference cost in USD (from the ancestor step span). */
  readonly costUsd?: number;
  /** Set when the item's turn was delegated by another turn (a subagent). */
  readonly subagent?: ConversationSubagent;
  readonly durationMs: number;
  readonly error: boolean;
}

/** Dispatch lineage for a subagent turn, read from the turn span. */
export interface ConversationSubagent {
  /** Subagent name, when the turn arrived through the subagent adapter. */
  readonly name?: string;
  /** Turn id of the dispatching parent turn. */
  readonly parentTurnId: string;
  /** Tool call id of the dispatch, when recorded. */
  readonly parentCallId?: string;
}

/** Max rendered lines for one collapsed card payload (args, result, or text). */
const CARD_PAYLOAD_LINES = 3;

/** Builds the conversation flow for a trace, one item per message/action. */
export function buildConversationItems(trace: LocalTrace): ConversationItem[] {
  const byId = new Map(trace.spans.map((span) => [span.spanId, span]));
  const children = new Map<string, LocalTraceSpan[]>();
  for (const span of trace.spans) {
    if (span.parentSpanId === undefined) continue;
    const siblings = children.get(span.parentSpanId) ?? [];
    siblings.push(span);
    children.set(span.parentSpanId, siblings);
  }
  for (const siblings of children.values()) siblings.sort(compareLocalTraceSpans);

  // Turns are matched by name, not by root position: they parent to the
  // `agent.session` window span when one exists (and to nothing on older
  // spools), and a subagent child's turns sit beside the parent's in the
  // same trace.
  const turns = trace.spans.filter((span) => span.name === "agent.turn");
  turns.sort(compareLocalTraceSpans);

  // Cards order by when their span started, not turn by turn: a parent
  // parks while its subagent runs and resumes afterwards, so the child's
  // cards belong between the parent's dispatch step and its final reply.
  // The system card pins to the front regardless.
  const entries: { readonly item: ConversationItem; readonly order: bigint }[] = [];
  for (const root of turns) {
    const subagent = turnSubagent(root);
    const subtree: LocalTraceSpan[] = [];
    const walk = (span: LocalTraceSpan): void => {
      subtree.push(span);
      for (const child of children.get(span.spanId) ?? []) walk(child);
    };
    walk(root);
    subtree.sort(compareLocalTraceSpans);

    if (entries.length === 0) {
      const systemSpan = subtree.find(
        (span) => isModelSpan(span) && typeof span.attributes["ai.prompt.system"] === "string",
      );
      const systemText = systemSpan?.attributes["ai.prompt.system"];
      if (systemSpan !== undefined && typeof systemText === "string" && systemText.length > 0) {
        entries.push({
          item: {
            kind: "system",
            durationMs: 0,
            error: false,
            span: systemSpan,
            subagent,
            text: systemText,
          },
          order: 0n,
        });
      }
    }
    const userText = extractUserText(subtree.find(isModelSpan));
    if (userText !== undefined) {
      entries.push({
        item: {
          kind: "user",
          durationMs: 0,
          error: false,
          span: root,
          subagent,
          text: userText,
        },
        order: root.startTimeNs,
      });
    }
    for (const span of subtree) {
      if (isModelSpan(span)) {
        const text = stringAttribute(span, "ai.response.text");
        const reasoning = stringAttribute(span, "ai.response.reasoning");
        const hasUsage =
          numberAttribute(span, "agent.usage.input_tokens") !== undefined ||
          numberAttribute(span, "agent.usage.output_tokens") !== undefined;
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
            inputTokens: numberAttribute(span, "agent.usage.input_tokens"),
            model: stringAttribute(span, "gen_ai.request.model"),
            outputTokens: numberAttribute(span, "agent.usage.output_tokens"),
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
        // Provider-executed tools (e.g. web_search) run inside the model
        // call and never get an ai.toolCall span; their results only exist
        // on the model span. Emit a card per result right after the
        // assistant card (same order, stable sort keeps emission order).
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
      } else if (span.name === "ai.toolCall") {
        entries.push({
          item: {
            kind: "tool",
            args: stringAttribute(span, "gen_ai.tool.call.arguments"),
            durationMs: spanDurationMs(span),
            error: span.statusCode === 2,
            name: stripTerminalControls(stringAttribute(span, "gen_ai.tool.name") ?? "tool"),
            result: unwrapJsonString(stringAttribute(span, "gen_ai.tool.call.result")),
            span,
            subagent,
          },
          order: span.startTimeNs,
        });
      }
    }
  }
  // Stable, so equal timestamps keep their per-turn emission order.
  return entries
    .sort((left, right) => (left.order === right.order ? 0 : left.order < right.order ? -1 : 1))
    .map((entry) => entry.item);
}

/** Reads the dispatch lineage a subagent turn carries on its turn span. */
function turnSubagent(turn: LocalTraceSpan): ConversationSubagent | undefined {
  const parentTurnId = stringAttribute(turn, "agent.parent.turn.id");
  if (parentTurnId === undefined) return undefined;
  const name = stringAttribute(turn, "agent.subagent.name");
  return {
    name: name === undefined ? undefined : stripTerminalControls(name),
    parentCallId: stringAttribute(turn, "agent.parent.call_id"),
    parentTurnId,
  };
}

/**
 * Renders one conversation card, width-clipped: a title row (bold kind plus
 * dim metadata, metrics right-aligned) over body rows. With `surfaces`
 * (derived from the terminal's background via the OSC 11 probe) the card
 * draws as two elevated bands; without them it falls back to a gutter rail —
 * the same vocabulary the dev transcript uses. Both layouts occupy identical
 * rows and columns, so scroll/click math and drag-copy column mapping never
 * depend on whether the probe was answered. Collapsed cards cap their
 * payloads; expanded ones render them in full.
 */
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
  // Surfaces are only derived for color themes, but guard anyway so a
  // no-color render can never emit their raw SGR sequences.
  const active = theme.color ? surfaces : undefined;
  // Titles read as primary text: the theme's bright white on an unknown
  // background, or the surface-matched primary (white on dark, black on
  // light) once the terminal has answered the background probe.
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
    // Reasoning renders as its own headed section so it never reads as part
    // of the reply, with a blank line separating it from what follows.
    if (reasoningLines.length > 0) {
      body.push(colors.dim("Thought:"), "", ...reasoningLines);
      if (textLines.length > 0) body.push("");
    }
    body.push(...textLines);
    // Tool-call-only response (no text): show the decision as the body.
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
    // A subagent's "user" message is the synthesized delegated prompt, not
    // something the user typed — label it as the task it is.
    const label = item.kind === "user" && item.subagent !== undefined ? "task" : item.kind;
    leftTitle = `${foldMarker(expanded, expandable, theme)}${colors.bold(primary(label))}`;
    rightTitle = "";
    const textUncapped =
      item.text === undefined || item.text.trim().length === 0
        ? []
        : wrapPlainText(item.text, inner);
    body.push(...(expanded ? textUncapped : capLines(textUncapped, inner)));
  }
  // Delegated work is called out on every card of the subagent's turn so it
  // never reads as the main conversation.
  if (item.subagent !== undefined) {
    const label = item.subagent.name === undefined ? "subagent" : `subagent:${item.subagent.name}`;
    leftTitle += colors.dim(` · ${label}`);
  }
  // Failures carry the transcript's error vocabulary: a red mark beside the
  // title, echoed by a red rail down the card's left edge.
  if (item.error) leftTitle += ` ${colors.red(glyph.error)}`;
  // A truncated card advertises its affordance: ellipsis on its own line,
  // a gap, then the click hint (which flips once open).
  if (!expanded && expandable) {
    body.push("…", "", colors.dim("Click to expand"));
  } else if (expanded && expandable) {
    body.push("", colors.dim("Click to collapse"));
  }

  // The header is a band with vertical padding on both sides of the title,
  // so the card's identity dominates its content; the body gets a padding
  // row at both ends.
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

/**
 * One card row. With a `surface` the row draws as a padded band on that
 * background — one cell of margin either side of the band, the selection bar
 * in the left margin — and the theme's own colors style the content. Without
 * one, a gutter rail groups the card's rows: dim normally, red when the card
 * failed, a bright half-block bar when selected. Both forms pad to the same
 * visible width (`inner = width - 8`), so the two layouts are cell-for-cell
 * interchangeable and nothing assumes a dark terminal palette.
 */
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
  // The second surface open re-establishes the band past any embedded style
  // reset in the clipped content, so the padding is covered too.
  return ` ${rail}${surface}  ${clipped}\x1b[0m${surface}${pad}  ${SURFACE_CLOSE}  `;
}

/**
 * The card's left-edge cell — constant for every row of one card: selection
 * bar (surface-matched primary so it stays visible on light backgrounds),
 * error rail, dim rail, or plain margin when a band already groups the card.
 */
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
  // Surfaced cards need no rail — the band groups them (error bands are red).
  if (surfaces !== undefined) return " ";
  return error ? colors.red(glyph.rule) : colors.dim(glyph.rule);
}

/**
 * Like {@link cardRow} but right-aligns `right` against the inner width so
 * metrics (duration, cost, tokens) line up across cards for quick scanning.
 * The left side clips first when the two don't fit together.
 */
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

/** Right-aligned metrics for an assistant card: duration, tokens, cost. */
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
  if (item.costUsd !== undefined) parts.push(formatCost(item.costUsd));
  return parts.length === 0 ? "" : colors.dim(parts.join(" · "));
}

/** Formats a USD cost with enough precision for typical AI inference prices. */
function formatCost(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

/** Reads the gateway cost from the model span's ancestor step span. */
function stepCostUsd(
  modelSpan: LocalTraceSpan,
  byId: Map<string, LocalTraceSpan>,
): number | undefined {
  // The model span (ai.streamText.doStream) is nested under an ai.streamText
  // outer-op span, which in turn sits under agent.step. Walk up to find it.
  let span: LocalTraceSpan | undefined = modelSpan;
  while (span.parentSpanId !== undefined) {
    span = byId.get(span.parentSpanId);
    if (span === undefined) return undefined;
    if (span.name === "agent.step") return numberAttribute(span, "gen_ai.usage.cost");
  }
  return undefined;
}

/** Fold affordance: ▸ when content is hidden behind the cap, ▾ when open. */
function foldMarker(expanded: boolean, expandable: boolean, theme: Theme): string {
  if (expanded) return `${theme.colors.dim("▾")} `;
  return expandable ? `${theme.colors.dim("▸")} ` : "";
}

/** Caps payload lines — the standalone `…` + click hint marks the cut. */
function capLines(lines: readonly string[], width: number): string[] {
  if (lines.length <= CARD_PAYLOAD_LINES) return [...lines];
  return [
    ...lines.slice(0, CARD_PAYLOAD_LINES - 1),
    clipVisible(lines[CARD_PAYLOAD_LINES - 1]!, Math.max(1, width)),
  ];
}

/** Rendered height of one card — the conversation viewport scrolls by lines. */
export function conversationItemLineCount(
  item: ConversationItem,
  width: number,
  theme: Theme,
  expanded: boolean,
): number {
  return renderConversationItem(item, width, theme, false, expanded).length;
}

/** Whether a card has content hidden behind the collapsed cap at this width. */
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
  // assistant
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

/** Rough chars-per-token estimate for text with no usage data (system prompts). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The user's message for a turn = the last user message in its first prompt. */
function extractUserText(firstModelSpan: LocalTraceSpan | undefined): string | undefined {
  if (firstModelSpan === undefined) return undefined;
  const raw = firstModelSpan.attributes["ai.prompt.messages"];
  if (typeof raw !== "string") return undefined;
  let messages: unknown;
  try {
    messages = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const text = contentText(message.content).trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

/** Text tool results are stored JSON-encoded; unwrap them to plain text. */
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
  return span.name.startsWith("ai.") && span.name.includes("do");
}

/** Extracts tool names from the `ai.response.tool_calls` JSON array. */
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

/** Parses the `ai.response.tool_results` JSON array of provider-executed tool outcomes. */
function parseProviderToolResults(raw: string | undefined): readonly ProviderToolResult[] {
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Capture-side truncation may collapse input/output to capped text, so
    // both structured values and pre-flattened strings appear here.
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
