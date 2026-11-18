import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  chatListSchema,
  type ChatSummary,
  type SaveChat,
} from "@shared/chat/schema";
import { chats, db } from "@db";
import { ensureScope } from "./scope";
import { waitForSessionOwnership } from "./sessions";

const chatRowSchema = z.object({
  channel: z.string().min(1).nullable(),
  costUsd: z.number().nonnegative().nullable(),
  createdAt: z.coerce.date(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  title: z.string().min(1),
  updatedAt: z.coerce.date(),
});

function toChatSummary(row: z.infer<typeof chatRowSchema>): ChatSummary {
  const { costUsd, createdAt, inputTokens, outputTokens, updatedAt, ...chat } =
    row;
  return {
    ...chat,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    usage: { costUsd, inputTokens, outputTokens },
  };
}

export async function listChats(scope: AccessScope) {
  const rows = chatRowSchema
    .array()
    .parse(
      await db
        .select()
        .from(chats)
        .where(eq(chats.workspaceId, scope.workspaceId))
        .orderBy(desc(chats.updatedAt))
    );
  return chatListSchema.parse(rows.map(toChatSummary));
}

export async function readChat(scope: AccessScope, sessionId: string) {
  const rows = await db
    .select()
    .from(chats)
    .where(
      and(
        eq(chats.workspaceId, scope.workspaceId),
        eq(chats.sessionId, sessionId)
      )
    )
    .limit(1);
  const row = chatRowSchema.optional().parse(rows[0]);
  return row ? toChatSummary(row) : undefined;
}

export async function saveChat(
  scope: AccessScope,
  chat: SaveChat & { readonly channel?: string }
) {
  // A session outside this workspace is indistinguishable from an unknown one.
  if (!(await waitForSessionOwnership(scope, chat.sessionId))) return;
  await ensureScope(scope);
  const now = new Date();
  const existing = await db
    .select({ sessionId: chats.sessionId })
    .from(chats)
    .where(
      and(
        eq(chats.workspaceId, scope.workspaceId),
        eq(chats.sessionId, chat.sessionId)
      )
    );
  if (existing.length === 0) {
    await db.insert(chats).values({
      channel: chat.channel ?? null,
      costUsd: chat.usage?.costUsd ?? null,
      createdAt: now,
      inputTokens: chat.usage?.inputTokens ?? 0,
      outputTokens: chat.usage?.outputTokens ?? 0,
      sessionId: chat.sessionId,
      title: chat.title ?? "New chat",
      updatedAt: now,
      workspaceId: scope.workspaceId,
    });
    return;
  }
  const updates: Partial<typeof chats.$inferInsert> = { updatedAt: now };
  if (chat.channel !== undefined) updates.channel = chat.channel;
  if (chat.title !== undefined) updates.title = chat.title;
  if (chat.usage !== undefined) {
    updates.costUsd = chat.usage.costUsd;
    updates.inputTokens = chat.usage.inputTokens;
    updates.outputTokens = chat.usage.outputTokens;
  }
  await db
    .update(chats)
    .set(updates)
    .where(
      and(
        eq(chats.workspaceId, scope.workspaceId),
        eq(chats.sessionId, chat.sessionId)
      )
    );
}
