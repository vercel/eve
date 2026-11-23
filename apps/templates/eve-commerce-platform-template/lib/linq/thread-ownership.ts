import { and, eq } from "drizzle-orm";
import { readVerifiedShopperPhone } from "@/lib/auth/users";
import { db } from "@/lib/db";
import { linqThreadOwners } from "@/lib/db/schema";
import { directLinqChatId, isDirectLinqThread } from "./transport";

/** Claim a verified DM before eve looks up its continuation. Never reassign it. */
export async function bindLinqThread(threadId: string, shopperId: string) {
  const chatId = directLinqChatId(threadId);
  if (!chatId) return false;
  const [owner] = await db
    .insert(linqThreadOwners)
    .values({ chatId, shopperId })
    .onConflictDoUpdate({
      target: linqThreadOwners.chatId,
      set: { shopperId },
      setWhere: eq(linqThreadOwners.shopperId, shopperId),
    })
    .returning({ chatId: linqThreadOwners.chatId });
  return owner !== undefined;
}

export async function canDeliverToLinqThread(threadId: string, shopperId: string) {
  const chatId = directLinqChatId(threadId);
  if (!chatId) return false;
  const [owner, phone] = await Promise.all([
    db.query.linqThreadOwners.findFirst({
      columns: { chatId: true },
      where: and(eq(linqThreadOwners.chatId, chatId), eq(linqThreadOwners.shopperId, shopperId)),
    }),
    readVerifiedShopperPhone(shopperId),
  ]);
  return owner !== undefined && phone !== undefined && isDirectLinqThread(threadId, phone);
}
