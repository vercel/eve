import { defineDynamic, defineTool, toolOutput } from "eve/tools";
import { defineState } from "eve/context";
import { z } from "zod";
import { sendNativeLinqMessage } from "@/lib/linq/transport";
import { scopeFromPrincipal } from "@/agent/lib/principal-scope";
import { readLinqOnboardingPhoneNumber } from "@/lib/linq/sign-in";
import { getInstallationSecrets } from "@/lib/auth/installation-secrets";
import { contactCardUrl } from "@/lib/messaging/contact-card";
import { getAgentName } from "@/lib/shoppers/agent-name";
import { env } from "@/lib/environment/env";
import {
  addReactionToMessageOutputSchema,
  reactToMessageOutputSchema,
} from "@/lib/messaging/reaction";
import { sendMessageOutputSchema } from "@/lib/messaging/message-delivery";

const contactDelivery = defineState<{
  userId: string;
  message: Extract<z.infer<typeof sendMessageOutputSchema>, { kind: "message" }>;
  sent: boolean;
} | null>("evey.contact-delivery", () => null);

function defineSendMessage() {
  return defineTool({
    description:
      "Send exactly one user-visible message to the current conversation. This is the delivery path for questions, progress updates, blockers, and final answers that need words. Choose kind message for plain text, private image artifacts, and HTTPS attachments; text and attachments may be combined, including in replies. Text is delivered exactly as written, so write it like a brief natural text message and do not use Markdown. Put nearly every response in a native quoted thread by setting replyTo: use current for an ordinary answer, clarification, status update, or follow-up prompted by the current user message, including when the user changes topics; use task with a task ID from the conversation's task state for delayed background work. Omit replyTo only when the message is genuinely standalone and does not answer any particular user message, such as an unsolicited announcement or proactive notice, or when no applicable handle is available. Use only handles present in the current context. Choose kind link with a URL to send a standalone native preview. To introduce links, such as an approval link or product pages, put up to four HTTPS URLs in a kind message's links: each is delivered as its own native preview right after the text, in order, from this one call. Put an ordinary URL in message text when a preview is not wanted. Call send_message multiple times only when you intentionally want separate messages. Call it directly without an assistant-text preamble, and do not repeat delivered content afterward.",
    inputSchema: sendMessageOutputSchema,
    execute(message) {
      return message;
    },
    toModelOutput() {
      return toolOutput.text(
        "The message was submitted to the active channel. Do not repeat it in assistant text.",
      );
    },
  });
}

function defineShareContact() {
  return defineTool({
    availableInSubagents: false,
    description:
      "Share your saveable contact card with your display name and phone number in the current conversation. Use when introducing yourself or when the user asks for your contact. Supply a brief natural introduction to deliver with the contact card. The tool resolves the number and attachment URL itself. Successful sharing is suppressed on repeat calls in this session; failed delivery can be retried. The user must tap the attachment to save it, so never claim it was saved. Call directly without a preamble and do not duplicate the introduction or attachment through send_message.",
    inputSchema: z.object({ text: z.string().trim().min(1).max(500) }),
    async execute({ text }, context) {
      const caller = context.session.auth.current ?? context.session.auth.initiator;
      if (!caller) throw new Error("Contact sharing requires an authenticated user.");
      const scope = scopeFromPrincipal(caller);
      const { userId } = scope;
      const channel = caller.attributes.conversationChannel;
      if (channel !== "linq" && channel !== "local") {
        throw new Error("Contact sharing requires an active iMessage conversation.");
      }
      let chatId: string | undefined;
      if (channel === "linq") {
        // Linq uses linq:<chatId>, with optional :dm/:group on older threads.
        const threadId = z
          .string()
          .regex(/^linq:([^:]+)(?::(?:dm|group))?$/)
          .safeParse(caller.attributes.linqThreadId);
        chatId = threadId.success ? threadId.data.split(":")[1] : undefined;
        if (
          !threadId.success ||
          !chatId ||
          chatId === "pending" ||
          caller.attributes.conversationId !== threadId.data
        ) {
          throw new Error("Contact sharing requires the current authenticated Linq conversation.");
        }
      }
      let delivery = contactDelivery.get();
      if (delivery?.userId !== userId) {
        const phone =
          env.LINQ_PHONE_NUMBER ??
          (env.LINQ_CONNECTOR
            ? await readLinqOnboardingPhoneNumber(env.LINQ_CONNECTOR)
            : undefined);
        if (!phone)
          throw new Error("The agent’s iMessage number is unavailable. Nothing was sent.");
        const [{ betterAuthSecret }, name] = await Promise.all([
          getInstallationSecrets(),
          getAgentName(scope),
        ]);
        delivery = {
          userId,
          sent: false,
          message: {
            kind: "message",
            text,
            attachments: [
              {
                kind: "file",
                mimeType: "text/vcard",
                name: "evey.vcf",
                url: contactCardUrl(phone, betterAuthSecret, name),
              },
            ],
          },
        };
        contactDelivery.update(() => delivery);
      }
      if (delivery.sent) return null;
      if (chatId) {
        const { text: introduction, attachments } = delivery.message;
        await sendNativeLinqMessage(
          chatId,
          {
            idempotency_key: `evey-contact:${context.session.id}`,
            parts: [
              ...(introduction ? [{ type: "text" as const, value: introduction }] : []),
              ...(attachments ?? []).map(({ url }) => ({
                type: "media" as const,
                url,
              })),
            ],
          },
          { signal: context.abortSignal },
        );
      }
      contactDelivery.update(() => ({ ...delivery, sent: true }));
      return delivery.message;
    },
    toModelOutput(output) {
      return toolOutput.text(
        output
          ? "The contact and introduction were accepted for delivery. Do not repeat them or claim the user saved the contact."
          : "The contact was already shared in this session. Nothing was sent; do not send it again.",
      );
    },
  });
}

export default defineDynamic((context) => {
  const isLinq = context.channel.kind === "channel:linq";
  const send_message = defineSendMessage();

  const react_to_message = defineTool({
    description: isLinq
      ? "Add or remove a native iMessage Tapback on the user's current message. Use this instead of send_message when a reaction fully communicates a lightweight acknowledgement and words would add nothing. Supports thumbs_up, thumbs_down, heart, laugh, exclamation (emphasis), and question."
      : "Acknowledge the user's current message with one compact reaction displayed in the conversation. Use this instead of send_message when the reaction fully communicates the response and words would add nothing. Supports thumbs_up, thumbs_down, heart, laugh, exclamation (emphasis), and question.",
    inputSchema: isLinq ? reactToMessageOutputSchema : addReactionToMessageOutputSchema,
    execute(reaction) {
      return reaction;
    },
    toModelOutput() {
      return toolOutput.text(
        "The reaction was submitted to the active conversation. Do not repeat it in assistant text.",
      );
    },
  });

  return { react_to_message, send_message, share_contact: defineShareContact() };
});
