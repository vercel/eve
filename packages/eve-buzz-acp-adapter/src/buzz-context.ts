import type { BuzzRoute, JsonRpcMessage } from "./types.js";

const CHANNEL_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EVENT_ID = "[0-9a-f]{64}";

export function promptText(prompt: unknown): string {
  return textBlocks(prompt).join("\n");
}

export function parseBuzzRoute(prompt: unknown): BuzzRoute | undefined {
  const blocks = textBlocks(prompt);
  const contexts = blocks.filter((block) => /^\[Context\]\s*$/m.test(block.split("\n", 1)[0]!));
  if (contexts.length !== 1) return undefined;
  const context = contexts[0]!;
  const channel = context.match(
    new RegExp(`^Channel:\\s*(?:.*\\(#(${CHANNEL_ID})\\)|(${CHANNEL_ID}))\\s*$`, "im"),
  );
  if (channel === null) return undefined;

  const eventIds = blocks.flatMap(triggeringEventIds);
  if (eventIds.length !== 1) return undefined;

  const route: BuzzRoute = {
    channelId: channel[1] ?? channel[2]!,
    triggeringEventId: eventIds[0]!,
  };
  const replyTo = context.match(new RegExp(`--reply-to\\s+(${EVENT_ID})`, "i"))?.[1];
  if (replyTo !== undefined) route.replyTo = replyTo;
  return route;
}

export function addReplySinkInstruction(message: JsonRpcMessage): JsonRpcMessage {
  const instruction =
    "[eve Buzz ACP connector]\n" +
    "The trusted local connector publishes your final ACP assistant text as the ordinary Buzz reply. " +
    "Do not call `buzz messages send` for that reply and do not search for the Buzz CLI. " +
    "Return the complete user-facing answer as assistant text. Buzz credentials are intentionally unavailable inside the eve runtime.";
  const existing = message.params?.prompt;
  const prompt = Array.isArray(existing) ? [...existing] : [];
  prompt.push({ type: "text", text: instruction });
  return { ...message, params: { ...message.params, prompt } };
}

function textBlocks(prompt: unknown): string[] {
  if (!Array.isArray(prompt)) return [];
  return prompt
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text);
}

function triggeringEventIds(block: string): string[] {
  const single = block.match(
    new RegExp(`^\\[Buzz event:[^\\n]*\\]\\nEvent ID:\\s*(${EVENT_ID})\\nChannel:`, "i"),
  );
  if (single !== null) return [single[1]!];

  const newSingle = block.match(
    new RegExp(
      `^\\[New (?:message — arrived while you were working|request — supersedes previous)\\]\\n\\n--- Event 1 \\([^\\n]*\\) ---\\nEvent ID:\\s*(${EVENT_ID})\\nChannel:`,
      "i",
    ),
  );
  if (newSingle !== null) return [newSingle[1]!];

  const count = eventCount(block);
  if (count === undefined) return [];
  const event = block.match(
    new RegExp(
      `^--- Event ${count} \\([^\\n]*\\) ---\\nEvent ID:\\s*(${EVENT_ID})\\nChannel:`,
      "im",
    ),
  );
  return event === null ? [] : [event[1]!];
}

function eventCount(block: string): number | undefined {
  const match = block.match(
    /^\[(?:Buzz events —|New messages — arrived while you were working —|New request — supersedes previous —)\s*(\d+) events\]/i,
  );
  if (match === null) return undefined;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count > 1 ? count : undefined;
}
