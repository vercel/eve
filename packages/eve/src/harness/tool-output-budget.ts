import { type AgentSettings, agentSettings } from "#execution/effective-agent-config.js";

/** The default `limits.toolOutputTokens`: about 48,000 UTF-8 bytes of tool text per result. */
export const DEFAULT_TOOL_OUTPUT_TOKENS = 12_000;

/** eve estimates a token as four UTF-8 bytes, the ratio its other tool limits use. */
const BYTES_PER_TOKEN = 4;

/** What a result is cut to: text, or a failure's text. */
type BoundedText = { readonly type: "text" | "error-text"; readonly value: string };

/** The step's agent's `limits.toolOutputTokens` in bytes; `undefined` when it turns them off. */
export function toolOutputBytes(step: Parameters<typeof agentSettings>[0]): number | undefined {
  return toolOutputBudgetBytes(agentSettings(step).toolOutputTokens);
}

export function toolOutputBudgetBytes(
  tokens: AgentSettings["toolOutputTokens"],
): number | undefined {
  if (tokens === false) return undefined;
  return (tokens ?? DEFAULT_TOOL_OUTPUT_TOKENS) * BYTES_PER_TOKEN;
}

/**
 * Keeps a tool result's text within `maxBytes` UTF-8 bytes, so one oversized result can't fill
 * every later request until compaction caps it. Oversized text keeps its start and end around a
 * single notice, which counts toward the budget. A content output's text parts share one budget
 * and one notice, and its file parts stay as they are. Oversized JSON becomes truncated text; a
 * result already within the budget is returned unchanged.
 */
export function boundToolOutput<T extends { readonly type: string }>(
  output: T,
  maxBytes: number,
): T | BoundedText {
  const { type, value } = output as { readonly type: string; readonly value?: unknown };
  switch (type) {
    case "text":
    case "error-text": {
      const parts = boundTexts([value as string], maxBytes);
      return parts === undefined ? output : { type, value: parts[0]! };
    }
    case "json":
    case "error-json": {
      const parts = boundTexts([JSON.stringify(value) ?? "null"], maxBytes);
      if (parts === undefined) return output;
      return { type: type === "json" ? "text" : "error-text", value: parts[0]! };
    }
    case "content": {
      const content = value as readonly { readonly type: string; readonly text?: string }[];
      const texts = content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []));
      const bounded = boundTexts(texts, maxBytes);
      if (bounded === undefined) return output;
      let index = 0;
      const kept = content.flatMap((part) => {
        if (part.type !== "text") return [part];
        const text = bounded[index++]!;
        return text === "" ? [] : [{ ...part, text }];
      });
      return { ...output, value: kept };
    }
    default:
      return output;
  }
}

/**
 * The texts cut to `maxBytes` in total, as one window over their concatenation: the first half of
 * the room left after the notice comes from the start, the rest from the end, and the notice goes
 * where the cut starts. Returns `undefined` when they already fit.
 */
function boundTexts(texts: readonly string[], maxBytes: number): string[] | undefined {
  const encoded = texts.map((text) => Buffer.from(text, "utf8"));
  const total = encoded.reduce((sum, bytes) => sum + bytes.length, 0);
  if (total <= maxBytes) return undefined;

  // Sized for the largest possible count so the real notice always fits.
  const room = Math.max(0, maxBytes - Buffer.byteLength(truncationNotice(total)));
  const headEnd = Math.floor(room / 2);
  const tailStart = total - (room - headEnd);

  let start = 0;
  let omitted = 0;
  let noticeAt: number | undefined;
  const kept = encoded.map((bytes, index) => {
    const headBytes = utf8Boundary(bytes, clamp(headEnd - start, 0, bytes.length), "back");
    const tailFrom = utf8Boundary(
      bytes,
      clamp(tailStart - start, headBytes, bytes.length),
      "forward",
    );
    start += bytes.length;
    omitted += tailFrom - headBytes;
    if (tailFrom > headBytes) noticeAt ??= index;
    return [
      bytes.subarray(0, headBytes).toString("utf8"),
      bytes.subarray(tailFrom).toString("utf8"),
    ];
  });
  return kept.map(([head, tail], index) =>
    index === noticeAt ? `${head}${truncationNotice(omitted)}${tail}` : `${head}${tail}`,
  );
}

function truncationNotice(omittedBytes: number): string {
  return `\n\n[eve truncated ${omittedBytes} bytes from the middle of this tool result to fit the tool output limit. Request a narrower part of the output if you need what was cut.]\n\n`;
}

/** The nearest offset at or around `index` that doesn't split a UTF-8 character. */
function utf8Boundary(bytes: Uint8Array, index: number, direction: "back" | "forward"): number {
  let at = index;
  while (at > 0 && at < bytes.length && (bytes[at]! & 0xc0) === 0x80) {
    at += direction === "back" ? -1 : 1;
  }
  return at;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
