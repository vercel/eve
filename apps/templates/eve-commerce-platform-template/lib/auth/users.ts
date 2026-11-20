import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";

export async function readVerifiedShopperPhone(shopperId: string) {
  if (!shopperId.startsWith("better-auth:")) return undefined;
  const id = shopperId.slice("better-auth:".length);
  const [match] = await db
    .select({ phone: user.phoneNumber })
    .from(user)
    .where(and(eq(user.id, id), eq(user.phoneNumberVerified, true)))
    .limit(1);
  return match?.phone ?? undefined;
}

export async function findVerifiedAuthUserIdByPhoneNumber(phoneNumber: string) {
  const [match] = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.phoneNumber, phoneNumber), eq(user.phoneNumberVerified, true)))
    .limit(1);
  return match?.id;
}
