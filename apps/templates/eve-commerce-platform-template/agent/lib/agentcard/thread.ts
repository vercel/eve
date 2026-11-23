import type { SessionAuthContext } from "eve/context";
import { z } from "zod";

// Agentcard keeps one open purchase per `threadId` and echoes the ID on every
// purchase update, so the ID names the conversation an update goes back to:
// an iMessage thread in one eve session (`linq:<chatId>#<sessionId>`) or a
// local development session (`local:<sessionId>`). Tying an iMessage purchase
// to its session starts a fresh Agentcard thread whenever the conversation
// gets a new session, so purchase history never outlives the agent's context.
const linqThreadIdSchema = z
  .string()
  .regex(/^linq:([^:#]+)(?::(?:dm|group))?$/)
  .refine((threadId) => !threadId.startsWith("linq:pending:"));
const localThreadIdSchema = z.string().regex(/^local:.+$/);
const sessionSeparator = "#";

export function agentcardThreadId(
  auth: {
    readonly current: SessionAuthContext | null;
    readonly initiator: SessionAuthContext | null;
  },
  sessionId: string,
) {
  // An Agentcard update about the shopper alone arrives with no conversation
  // attributes; the session's first message still names its conversation.
  const caller = auth.current?.attributes.conversationChannel ? auth.current : auth.initiator;
  if (!caller) throw new Error("Shopping requires an authenticated user.");
  const channel = z.enum(["linq", "local"]).parse(caller.attributes.conversationChannel);
  if (channel === "local") return `local:${sessionId}`;
  const threadId = linqThreadIdSchema.safeParse(caller.attributes.linqThreadId);
  if (!threadId.success || caller.attributes.conversationId !== threadId.data) {
    throw new Error("Shopping requires the current iMessage conversation.");
  }
  return `${threadId.data}${sessionSeparator}${sessionId}`;
}

export function agentcardThreadTarget(threadId: string) {
  const [linqThreadId = "", sessionId, ...rest] = threadId.split(sessionSeparator);
  if (linqThreadIdSchema.safeParse(linqThreadId).success) {
    if (!sessionId || rest.length > 0) return undefined;
    return { channel: "linq", sessionId, threadId: linqThreadId } as const;
  }
  if (localThreadIdSchema.safeParse(threadId).success) {
    return {
      channel: "local",
      sessionId: threadId.slice("local:".length),
    } as const;
  }
  return undefined;
}
