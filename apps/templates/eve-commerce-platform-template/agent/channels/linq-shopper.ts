import type { LinqAPIV3 } from "@linqapp/sdk";
import type { AdapterPostableMessage } from "chat";
import { defaultLinqAuth, linqChannel } from "eve/channels/linq";
import { z } from "zod";
import { resolveLinqReplyTarget } from "@/agent/lib/reply-targets";
import { scopeFromPrincipal } from "@/agent/lib/principal-scope";
import { findVerifiedAuthUserIdByPhoneNumber } from "@/lib/auth/users";
import { sendMessageToolResultSchema } from "@/lib/messaging/message-delivery";
import { reactToMessageToolResultSchema } from "@/lib/messaging/reaction";
import { settledToolResult } from "@/agent/lib/settled-tool-result";
import { accessScopeForUser } from "@/lib/auth/scope";
import { normalizeAuthPhoneNumber } from "@/lib/auth/phone-number";
import { prepareLinqImageArtifactDelivery } from "@/lib/linq/images";
import { bindLinqThread, canDeliverToLinqThread } from "@/lib/linq/thread-ownership";
import { isDirectLinqThread, linqCredentials, sendNativeLinqMessage } from "@/lib/linq/transport";

const unavailableReplyTargetSchema = z.object({
  status: z.union([z.literal(400), z.literal(404)]),
});

type LinqMessageContent = Parameters<LinqAPIV3["chats"]["messages"]["send"]>[1]["message"];

// The file stem gives this channel a new continuation namespace. Do not
// resume legacy Linq sessions whose threads were not bound to a shopper.
export default linqChannel({
  route: "/eve/v1/linq",
  credentials: linqCredentials,
  events: {
    async "interaction.opened"(event, ctx) {
      const { origin, request } = event.data;
      const { thread } = ctx.channel;
      if (
        request.kind !== "sign-in" ||
        !thread ||
        (origin !== undefined && origin.sessionId !== ctx.session.id)
      )
        return;
      const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
      if (
        caller?.principalType !== "user" ||
        !(await canDeliverToLinqThread(thread.id, caller.principalId))
      )
        return;
      const signIn = request.signIn;
      const displayName = signIn?.displayName ?? signIn?.name ?? "this account";
      const adapter = ctx.channel.bot.getAdapter("linq");
      const { chatId, pendingHandle } = adapter.decodeThreadId(thread.id);
      if (!chatId || pendingHandle)
        throw new Error("Authorization delivery requires an existing Linq conversation.");
      const parts: NonNullable<LinqMessageContent["parts"]> = [
        {
          type: "text",
          value: [
            signIn?.instructions ?? `Connect ${displayName} to continue.`,
            signIn?.userCode ? `Code: ${signIn.userCode}` : undefined,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ];
      const idempotencyKey = `authorization:${ctx.session.id}:${event.data.interactionId}`;
      await sendNativeLinqMessage(chatId, {
        parts,
        idempotency_key: `${idempotencyKey}:prompt`,
      });
      // Linq requires a native link to be the message's only part.
      if (signIn?.url)
        await sendNativeLinqMessage(chatId, {
          parts: [{ type: "link", value: signIn.url }],
          idempotency_key: `${idempotencyKey}:link`,
        });
    },
    async "call.settled"(event, ctx) {
      const context = ctx.channel;
      const session = ctx;
      const result = settledToolResult(event, ctx.view);
      const reaction = reactToMessageToolResultSchema.safeParse(result);
      const message = sendMessageToolResultSchema.safeParse(result);
      if (!reaction.success && !message.success) return;
      const { thread } = context;
      const principal = ctx.session.auth.current ?? ctx.session.auth.initiator;
      if (
        !thread ||
        principal?.principalType !== "user" ||
        !(await canDeliverToLinqThread(thread.id, principal.principalId))
      )
        return;
      if (reaction.success) {
        // The thread is a persisted snapshot; auth identifies this incoming message.
        const target = resolveLinqReplyTarget({ kind: "current" }, session.session.auth);
        const messageId = target?.conversationId === thread.id ? target.messageId : undefined;
        if (!messageId) {
          throw new Error("react_to_message requires a current Linq message.");
        }
        const adapter = context.bot.getAdapter("linq");
        if (reaction.data.output.operation === "remove") {
          await adapter.removeReaction(thread.id, messageId, reaction.data.output.type);
        } else {
          await adapter.addReaction(thread.id, messageId, reaction.data.output.type);
        }
        return;
      }

      if (message.success && message.data.toolName === "send_message") {
        const replyTarget = resolveLinqReplyTarget(
          message.data.output.replyTo,
          session.session.auth,
        );
        const requestedReplyMessageId =
          replyTarget?.conversationId === thread.id ? replyTarget.messageId : undefined;
        const adapter = context.bot.getAdapter("linq");
        const post = (content: AdapterPostableMessage) => thread.post(content);
        const { chatId, pendingHandle } = adapter.decodeThreadId(thread.id);
        if (pendingHandle || !chatId) {
          throw new Error("A Linq reply requires an existing conversation.");
        }

        const sendLinkCard = async (url: string) => {
          const sendLink = (replyToMessageId?: string) => {
            const nativeMessage: LinqMessageContent = {
              parts: [{ type: "link", value: url }],
            };
            if (replyToMessageId) {
              nativeMessage.reply_to = { message_id: replyToMessageId };
            }
            return sendNativeLinqMessage(chatId, nativeMessage);
          };
          try {
            await sendLink(requestedReplyMessageId);
          } catch (error) {
            if (
              !requestedReplyMessageId ||
              !unavailableReplyTargetSchema.safeParse(error).success
            ) {
              throw error;
            }
            console.warn("[linq] reply target is unavailable", {
              sessionId: session.session.id,
            });
            await sendLink();
          }
        };

        if (message.data.output.kind === "link") {
          await sendLinkCard(message.data.output.url);
          return;
        }

        // The link cards a message carries follow its text, in order.
        const { links } = message.data.output;
        const sendMessageLinks = async () => {
          for (const url of links ?? []) await sendLinkCard(url);
        };

        const attachments = message.data.output.attachments?.map(({ kind, ...attachment }) => ({
          ...attachment,
          type: kind,
        }));
        const { text: requestedText } = message.data.output;
        if (!requestedText) {
          if (attachments?.length) {
            await post({ attachments, raw: "" });
          }
          await sendMessageLinks();
          return;
        }

        const delivery = await prepareLinqImageArtifactDelivery(requestedText, {
          rootSessionId: session.session.id,
          scope: scopeFromPrincipal(principal),
        });
        if (delivery.failedArtifactIds.length > 0) {
          console.warn("[linq] browser image delivery failed", {
            artifactIds: delivery.failedArtifactIds,
            sessionId: session.session.id,
          });
        }
        const failureMessage =
          delivery.failedArtifactIds.length === 0
            ? ""
            : delivery.failedArtifactIds.length === 1
              ? "I couldn't attach one image."
              : `I couldn't attach ${String(delivery.failedArtifactIds.length)} images.`;
        const text = [delivery.text, failureMessage].filter(Boolean).join("\n\n");
        const outgoing: Extract<Parameters<typeof thread.post>[0], { raw: string }> = { raw: text };
        if (attachments?.length) outgoing.attachments = attachments;
        if (delivery.files.length > 0) outgoing.files = delivery.files;
        await sendLinqMessage({
          chatId,
          outgoing,
          post,
          replyToMessageId: requestedReplyMessageId,
        });
        await sendMessageLinks();
      }
    },
    // Linq output is delivered only through send_message, so the default
    // reply posting is replaced with a no-op.
    // oxlint-disable-next-line eslint/no-empty-function -- Overriding the built-in handler suppresses automatic reply posting.
    async "content.completed"() {},
  },
  async onMessage(context, message) {
    if (message.author.isBot) return null;

    const auth = defaultLinqAuth(message);
    const authorUserName = z.string().safeParse(message.author.userName);
    const phoneNumber = authorUserName.success
      ? normalizeAuthPhoneNumber(authorUserName.data)
      : undefined;
    const verifiedUserId = phoneNumber
      ? await findVerifiedAuthUserIdByPhoneNumber(phoneNumber)
      : undefined;
    if (!verifiedUserId || !phoneNumber) {
      console.warn("[linq] ignoring message from an unlinked handle", {
        threadId: context.thread.id,
      });
      return null;
    }
    if (!context.thread.isDM && !(await isDirectLinqThread(context.thread.id, phoneNumber))) {
      return null;
    }
    const principalId = `better-auth:${verifiedUserId}`;
    if (!(await bindLinqThread(context.thread.id, principalId))) {
      console.warn("[linq] ignoring a chat that is not owned by the sender");
      return null;
    }
    const scope = accessScopeForUser(principalId);
    return {
      auth: {
        ...auth,
        attributes: {
          ...auth.attributes,
          conversationChannel: "linq",
          conversationId: context.thread.id,
          linqThreadId: context.thread.id,
          linqMessageId: message.id,
          phoneNumber,
          workspaceId: scope.workspaceId,
        },
        principalId,
      },
    };
  },
});

async function sendLinqMessage({
  chatId,
  outgoing,
  post,
  replyToMessageId,
}: {
  readonly chatId: string;
  readonly outgoing: Extract<AdapterPostableMessage, { raw: string }>;
  readonly post: (content: AdapterPostableMessage) => Promise<unknown>;
  readonly replyToMessageId?: string;
}) {
  // Keep uploads on the Chat SDK adapter; native replies handle plain text.
  if (
    !replyToMessageId ||
    !outgoing.raw ||
    outgoing.attachments?.length ||
    outgoing.files?.length
  ) {
    await post(outgoing);
    return;
  }
  try {
    await sendNativeLinqMessage(chatId, {
      parts: [{ type: "text", value: outgoing.raw }],
      reply_to: { message_id: replyToMessageId },
    });
    return;
  } catch (error) {
    if (!unavailableReplyTargetSchema.safeParse(error).success) throw error;
    console.warn("[linq] reply target is unavailable", {
      replyToMessageId,
    });
    await post(outgoing);
  }
}
