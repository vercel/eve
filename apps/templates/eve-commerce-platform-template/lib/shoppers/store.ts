import { db } from "@/lib/db";
import { shoppers } from "@/lib/db/schema";
import type { AccessScope } from "@/lib/auth/scope";

export async function ensureShopper(scope: AccessScope) {
  await db.insert(shoppers).values({ id: scope.userId }).onConflictDoNothing();
}
