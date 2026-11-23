import { eq } from "drizzle-orm";
import type { AccessScope } from "@/lib/auth/scope";
import { db } from "@/lib/db";
import { shoppers } from "@/lib/db/schema";

const defaultGatewayModel = "openai/gpt-6.1-sol-fast";

export async function getGatewayModel(scope: AccessScope) {
  const [shopper] = await db
    .select({ modelId: shoppers.modelId })
    .from(shoppers)
    .where(eq(shoppers.id, scope.userId))
    .limit(1);
  return shopper?.modelId ?? defaultGatewayModel;
}

export async function selectGatewayModel(scope: AccessScope, modelId: string) {
  await db
    .insert(shoppers)
    .values({ id: scope.userId, modelId })
    .onConflictDoUpdate({ target: shoppers.id, set: { modelId } });
}
