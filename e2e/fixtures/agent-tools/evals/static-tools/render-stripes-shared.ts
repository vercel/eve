import type { SessionStreamEvent } from "eve/client";
import { toolCallsOf } from "eve/evals";

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

export function renderedColors(events: readonly SessionStreamEvent[]): readonly string[] {
  for (const call of toolCallsOf(events)) {
    if (call.name !== TOOL_NAME || call.status !== "completed") continue;
    const output = call.output as { readonly colors?: unknown };
    if (Array.isArray(output?.colors) && output.colors.every((c) => typeof c === "string")) {
      return output.colors as string[];
    }
  }
  return [];
}

/** Final (non-tool-call) assistant messages, in turn order. */
export function assistantAnswers(events: readonly SessionStreamEvent[]): readonly string[] {
  return events.flatMap((event) =>
    event.type === "content.completed" &&
    event.data.phase === "reply" &&
    typeof event.data.value === "string" &&
    event.data.value.trim().length > 0
      ? [event.data.value]
      : [],
  );
}

export function namesColorsInOrder(events: readonly SessionStreamEvent[], answer: string): boolean {
  const colors = renderedColors(events);
  if (colors.length === 0) return false;
  const pattern = new RegExp(colors.map((color) => `\\b${color}\\b`).join("[\\s\\S]*"), "iu");
  return pattern.test(answer);
}
