import { eq } from "drizzle-orm";
import type { AccessScope } from "@/lib/auth/scope";
import { db } from "@/lib/db";
import { shoppers } from "@/lib/db/schema";
import { agentNameSchema, defaultAgentName } from "./agent-name-schema";

export async function getAgentName(scope: AccessScope) {
  const [shopper] = await db
    .select({ name: shoppers.agentName })
    .from(shoppers)
    .where(eq(shoppers.id, scope.userId))
    .limit(1);
  return shopper?.name ?? defaultAgentName;
}

export async function setAgentName(scope: AccessScope, name: string) {
  const agentName = agentNameSchema.parse(name);
  await db
    .insert(shoppers)
    .values({ id: scope.userId, agentName })
    .onConflictDoUpdate({ target: shoppers.id, set: { agentName } });
  return agentName;
}
