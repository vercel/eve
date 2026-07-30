import type { BuzzRoute, JsonRpcMessage } from "./types.js";

const CHANNEL_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EVENT_ID = "[0-9a-f]{64}";

export function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

export function parseBuzzRoute(text: string): BuzzRoute | undefined {
  const contextStart = text.search(/^\[Context\]\s*$/m);
  if (contextStart < 0) return undefined;
  const afterContext = text.slice(contextStart + "[Context]".length);
  const nextSection = afterContext.search(/^\[[^\n]+\]\s*$/m);
  const context = nextSection < 0 ? afterContext : afterContext.slice(0, nextSection);

  const channel = context.match(
    new RegExp(`^Channel:\\s*(?:.*\\(#(${CHANNEL_ID})\\)|(${CHANNEL_ID}))\\s*$`, "im"),
  );
  if (channel === null) return undefined;

  const replyTo = context.match(new RegExp(`--reply-to\\s+(${EVENT_ID})`, "i"))?.[1];
  if (!replyTo) return undefined;
  return { channelId: channel[1] ?? channel[2]!, replyTo };
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
