import { and, eq } from "drizzle-orm";
import type { AccessScope } from "@/lib/auth/scope";
import { db } from "@/lib/db";
import { agentcardOrders } from "@/lib/db/schema";
import { ensureShopper } from "@/lib/shoppers/store";

type SavedOrder = Omit<typeof agentcardOrders.$inferInsert, "createdAt" | "shopperId">;

// The first save of an order wins: the cart it placed does not change later.
export async function saveAgentcardOrder(scope: AccessScope, order: SavedOrder) {
  await ensureShopper(scope);
  await db
    .insert(agentcardOrders)
    .values({ ...order, shopperId: scope.userId })
    .onConflictDoNothing({
      target: [agentcardOrders.shopperId, agentcardOrders.orderId],
    });
}

export async function readAgentcardOrder(scope: AccessScope, orderId: string) {
  const [row] = await db
    .select()
    .from(agentcardOrders)
    .where(and(eq(agentcardOrders.shopperId, scope.userId), eq(agentcardOrders.orderId, orderId)))
    .limit(1);
  return row;
}
