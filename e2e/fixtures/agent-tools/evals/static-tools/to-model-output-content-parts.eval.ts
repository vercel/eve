import type { HandleMessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

const TOOL_NAME = "render-stripes";

// The stripe colors are randomized per run, so a blind model cannot pass by
// guessing; the eval stays self-contained by validating the reply against
// the answer key the tool records on action.result. The pixels reach the
// model exclusively through `toModelOutput` content parts.
export default defineEval({
  description: "Static tools smoke: toModelOutput content parts deliver an image to the model.",
  async test(t) {
    await t.send(
      `Call \`${TOOL_NAME}\` exactly once, look at the rendered image, and reply with only ` +
        "the stripe colors left to right, comma-separated.",
    );

    t.succeeded();
    t.noFailedActions();
    t.calledTool(TOOL_NAME, { count: 1, output: isRenderStripesOutput });
    t.eventsSatisfy("a reply names the rendered colors in order", (events) => {
      const answer = assistantAnswers(events)[0];
      return answer !== undefined && namesColorsInOrder(events, answer);
    });

    // The content part is baked into persisted history, so a follow-up turn
    // must answer from replay without re-running the tool.
    await t.send(
      "Without calling any tool, repeat the stripe colors left to right, comma-separated.",
    );

    t.succeeded();
    t.calledTool(TOOL_NAME, { count: 1 });
    t.eventsSatisfy("the replayed image still answers the follow-up", (events) => {
      const answer = assistantAnswers(events).at(-1);
      return answer !== undefined && namesColorsInOrder(events, answer);
    });
  },
});

function isRenderStripesOutput(value: unknown): boolean {
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

function renderedColors(events: readonly HandleMessageStreamEvent[]): readonly string[] {
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
function assistantAnswers(events: readonly HandleMessageStreamEvent[]): readonly string[] {
  return events.flatMap((event) =>
    event.type === "message.completed" &&
    event.data.finishReason !== "tool-calls" &&
    event.data.message !== null &&
    event.data.message.trim().length > 0
      ? [event.data.message]
      : [],
  );
}

function namesColorsInOrder(events: readonly HandleMessageStreamEvent[], answer: string): boolean {
  const colors = renderedColors(events);
  if (colors.length === 0) return false;
  const pattern = new RegExp(colors.map((color) => `\\b${color}\\b`).join("[\\s\\S]*"), "iu");
  return pattern.test(answer);
}
