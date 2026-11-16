import type { EveEvalContext, EveEvalTurn } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { z } from "zod";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";

export const agentEvalTags = ["agent", "behavior"] as const;

export async function requireDeliveredText(
  t: EveEvalContext,
  turn: EveEvalTurn
) {
  const delivery = turn.requireToolCall("send_message", {
    status: "completed",
  });
  const parsed = sendMessageOutputSchema.safeParse(delivery.input);
  const text =
    parsed.success && parsed.data.kind === "message"
      ? parsed.data.text
      : undefined;
  const parsedText = z.string().trim().min(1).safeParse(text);

  await t.require(parsedText.success, equals(true));
  if (!parsedText.success) {
    throw new Error("send_message did not deliver non-empty text.");
  }
  return parsedText.data;
}

export function assertPlainTextDelivery(t: EveEvalContext, text: string) {
  t.check(
    text,
    satisfies<string>(
      (value) =>
        !/(?:^|\n)#{1,6}\s/u.test(value) &&
        !/(?:^|\n)\s*(?:[-*+] |\d+\. )/u.test(value) &&
        !/\*\*|```|\[[^\]]+\]\([^)]+\)/u.test(value),
      "delivery uses plain iMessage text instead of Markdown"
    )
  );
}
