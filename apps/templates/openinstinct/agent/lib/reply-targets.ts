import { defineState, type SessionAuth } from "eve/context";
import { z } from "zod";
import { scheduledReportIdentity } from "@agent/lib/schedules/identity";
import type { ReplyReference } from "@shared/chat/message-delivery";

const linqReplyTargetSchema = z.strictObject({
  conversationId: z.string().startsWith("linq:"),
  messageId: z.string().min(1),
});

type LinqReplyTarget = z.infer<typeof linqReplyTargetSchema>;

const backgroundReplyTargets = defineState<Record<string, LinqReplyTarget>>(
  "open-instinct.background-reply-targets",
  () => ({})
);

const maximumBackgroundReplyTargets = 100;

export function registerBackgroundReplyTarget(
  taskId: string,
  auth: SessionAuth
) {
  const target = currentLinqReplyTarget(auth);
  if (!target) return;

  backgroundReplyTargets.update((current) =>
    Object.fromEntries(
      [
        ...Object.entries(current).filter(([id]) => id !== taskId),
        [taskId, target] as const,
      ].slice(-maximumBackgroundReplyTargets)
    )
  );
}

export function resolveLinqReplyTarget(
  reference: ReplyReference | undefined,
  auth: SessionAuth
) {
  if (!reference) return undefined;

  const conversationId = currentLinqConversationId(auth);
  if (!conversationId) return undefined;

  if (reference.kind === "current") {
    return currentLinqReplyTarget(auth);
  }

  if (reference.kind === "task") {
    const target = backgroundReplyTargets.get()[reference.id];
    return target?.conversationId === conversationId ? target : undefined;
  }

  const report = scheduledReportIdentity(auth);
  if (report?.scheduleId !== reference.id || !report.replyAnchorMessageId) {
    return undefined;
  }
  return {
    conversationId,
    messageId: report.replyAnchorMessageId,
  } satisfies LinqReplyTarget;
}

function currentLinqConversationId(auth: SessionAuth) {
  const caller = auth.current ?? auth.initiator;
  if (caller?.attributes.conversationChannel !== "linq") return undefined;
  const parsed = z
    .string()
    .startsWith("linq:")
    .safeParse(caller.attributes.conversationId);
  return parsed.success ? parsed.data : undefined;
}

function currentLinqReplyTarget(auth: SessionAuth) {
  const caller = auth.current;
  if (caller?.attributes.conversationChannel !== "linq") return undefined;
  const parsed = linqReplyTargetSchema.safeParse({
    conversationId: caller.attributes.conversationId,
    messageId: caller.attributes.linqMessageId,
  });
  return parsed.success ? parsed.data : undefined;
}
