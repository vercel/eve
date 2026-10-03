import type { MessageStreamEvent } from "eve/client";

export const TOOL_NAME = "render-stripes";

export function isRenderStripesOutput(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const output = value as { readonly colors?: unknown; readonly imageBase64?: unknown };
  return (
    Array.isArray(output.colors) &&
    output.colors.length > 0 &&
    output.colors.every((color) => typeof color === "string") &&
    typeof output.imageBase64 === "string" &&
    output.imageBase64.startsWith("iVBOR") // PNG magic bytes, base64-encoded
  );
}

export function renderedColors(events: readonly MessageStreamEvent[]): readonly string[] {
  for (const event of events) {
    if (event.type !== "action.result" || event.data.result.kind !== "tool-result") continue;
    if (event.data.result.toolName !== TOOL_NAME) continue;
    const output = event.data.result.output as { readonly colors?: unknown };
    if (Array.isArray(output?.colors) && output.colors.every((c) => typeof c === "string")) {
      return output.colors as string[];
    }
  }
  return [];
}

/** Final (non-tool-call) assistant messages, in turn order. */
export function assistantAnswers(events: readonly MessageStreamEvent[]): readonly string[] {
  return events.flatMap((event) =>
    event.type === "message.completed" &&
    event.data.finishReason !== "tool-calls" &&
    event.data.message.trim().length > 0
      ? [event.data.message]
      : [],
  );
}

export function namesColorsInOrder(events: readonly MessageStreamEvent[], answer: string): boolean {
  const colors = renderedColors(events);
  if (colors.length === 0) return false;
  const pattern = new RegExp(colors.map((color) => `\\b${color}\\b`).join("[\\s\\S]*"), "iu");
  return pattern.test(answer);
}
