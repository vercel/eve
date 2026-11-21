import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import type { AccessScope } from "@/lib/auth/scope";
import { db } from "@/lib/db";
import { shoppers, shoppingWatches } from "@/lib/db/schema";
import { ensureShopper } from "@/lib/shoppers/store";

const openStatuses = ["active", "ready_to_notify"] as const;
const hourMs = 60 * 60_000;
export const watchLifetimeDays = 30;

export async function createWatch(
  scope: AccessScope,
  input: Pick<
    typeof shoppingWatches.$inferInsert,
    "kind" | "productName" | "productUrl" | "targetUsdCents" | "threadId"
  >,
) {
  await ensureShopper(scope);
  return db.transaction(async (tx) => {
    await tx
      .select({ id: shoppers.id })
      .from(shoppers)
      .where(eq(shoppers.id, scope.userId))
      .for("update");
    const filter = and(
      eq(shoppingWatches.shopperId, scope.userId),
      inArray(shoppingWatches.status, openStatuses),
    );
    const [active] = await tx.select({ count: count() }).from(shoppingWatches).where(filter);
    if ((active?.count ?? 0) >= 10)
      throw new Error("You can have up to 10 active watches. Stop one first.");
    const [watch] = await tx
      .insert(shoppingWatches)
      .values({
        ...input,
        shopperId: scope.userId,
        expiresAt: new Date(Date.now() + watchLifetimeDays * 24 * hourMs),
      })
      .returning({ id: shoppingWatches.id, expiresAt: shoppingWatches.expiresAt });
    if (!watch) throw new Error("Could not create the watch.");
    return watch;
  });
}

export function listWatches(scope: AccessScope) {
  return db
    .select({
      id: shoppingWatches.id,
      kind: shoppingWatches.kind,
      productName: shoppingWatches.productName,
      productUrl: shoppingWatches.productUrl,
      targetUsdCents: shoppingWatches.targetUsdCents,
      status: shoppingWatches.status,
      lastCheck: shoppingWatches.lastCheck,
      expiresAt: shoppingWatches.expiresAt,
    })
    .from(shoppingWatches)
    .where(eq(shoppingWatches.shopperId, scope.userId))
    .orderBy(
      desc(inArray(shoppingWatches.status, openStatuses)),
      desc(shoppingWatches.createdAt),
      desc(shoppingWatches.id),
    )
    .limit(20);
}

export async function stopWatch(scope: AccessScope, id: string) {
  const [stopped] = await db
    .update(shoppingWatches)
    .set({ status: "stopped", leaseToken: null, leaseExpiresAt: null })
    .where(
      and(
        eq(shoppingWatches.shopperId, scope.userId),
        eq(shoppingWatches.id, id),
        inArray(shoppingWatches.status, openStatuses),
      ),
    )
    .returning({ id: shoppingWatches.id });
  return Boolean(stopped);
}

export async function claimDueWatches(now = new Date()) {
  return db.transaction(async (tx) => {
    await tx
      .update(shoppingWatches)
      .set({ status: "expired", leaseToken: null, leaseExpiresAt: null })
      .where(
        and(inArray(shoppingWatches.status, openStatuses), lte(shoppingWatches.expiresAt, now)),
      );
    const due = await tx
      .select({ id: shoppingWatches.id })
      .from(shoppingWatches)
      .where(
        and(
          inArray(shoppingWatches.status, openStatuses),
          lte(shoppingWatches.nextCheckAt, now),
          or(isNull(shoppingWatches.leaseExpiresAt), lte(shoppingWatches.leaseExpiresAt, now)),
        ),
      )
      .orderBy(asc(shoppingWatches.nextCheckAt))
      .limit(8)
      .for("update", { skipLocked: true });
    if (!due.length) return [];
    return tx
      .update(shoppingWatches)
      .set({ leaseToken: randomUUID(), leaseExpiresAt: new Date(now.getTime() + 2 * 60_000) })
      .where(
        inArray(
          shoppingWatches.id,
          due.map(({ id }) => id),
        ),
      )
      .returning();
  });
}

export async function saveCheck(
  id: string,
  token: string,
  check: "no_match" | "unreadable" | { alert: string },
  now = new Date(),
) {
  const [saved] = await db
    .update(shoppingWatches)
    .set(
      typeof check === "string"
        ? {
            lastCheck: check,
            nextCheckAt: new Date(now.getTime() + hourMs),
            leaseToken: null,
            leaseExpiresAt: null,
          }
        : {
            lastCheck: "matched",
            alertText: check.alert,
            status: "ready_to_notify",
          },
    )
    .where(
      and(
        eq(shoppingWatches.id, id),
        eq(shoppingWatches.leaseToken, token),
        eq(shoppingWatches.status, "active"),
        gt(shoppingWatches.leaseExpiresAt, now),
      ),
    )
    .returning({ id: shoppingWatches.id });
  return Boolean(saved);
}

export async function readPendingAlert(id: string, token: string, now = new Date()) {
  const [watch] = await db
    .select({ alert: shoppingWatches.alertText })
    .from(shoppingWatches)
    .where(
      and(
        eq(shoppingWatches.id, id),
        eq(shoppingWatches.leaseToken, token),
        eq(shoppingWatches.status, "ready_to_notify"),
        gt(shoppingWatches.leaseExpiresAt, now),
        gt(shoppingWatches.expiresAt, now),
      ),
    )
    .limit(1);
  return watch?.alert ?? undefined;
}

export async function finishNotification(
  id: string,
  token: string,
  outcome: "sent" | "retry" | "stopped",
  now = new Date(),
) {
  await db
    .update(shoppingWatches)
    .set({
      status:
        outcome === "sent" ? "notified" : outcome === "stopped" ? "stopped" : "ready_to_notify",
      nextCheckAt: new Date(now.getTime() + hourMs),
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(shoppingWatches.id, id),
        eq(shoppingWatches.leaseToken, token),
        eq(shoppingWatches.status, "ready_to_notify"),
      ),
    );
}
