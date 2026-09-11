import { eq } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import type { PhoneLinkRecord } from "#shared/types/phone-link";

const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

export function normalizePhoneNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const normalized = trimmed.startsWith("+") ? trimmed : `+${trimmed.replace(/\D/g, "")}`;
  if (!E164_PATTERN.test(normalized)) {
    throw createError({
      statusCode: 400,
      statusMessage: "Phone number must be in E.164 format (e.g. +33612345678)",
    });
  }

  return normalized;
}

function rowToRecord(row: typeof schema.phoneLinks.$inferSelect): PhoneLinkRecord {
  return {
    appUserId: row.appUserId,
    phoneNumber: row.phoneNumber,
    linkedAt: row.linkedAt,
  };
}

export async function getPhoneLinkForAppUser(appUserId: string) {
  const [row] = await db
    .select()
    .from(schema.phoneLinks)
    .where(eq(schema.phoneLinks.appUserId, appUserId))
    .limit(1);

  return row ? rowToRecord(row) : undefined;
}

export async function getPhoneLinkByPhoneNumber(phoneNumber: string) {
  const normalized = normalizePhoneNumber(phoneNumber);

  const [row] = await db
    .select()
    .from(schema.phoneLinks)
    .where(eq(schema.phoneLinks.phoneNumber, normalized))
    .limit(1);

  return row ? rowToRecord(row) : undefined;
}

export async function upsertPhoneLinkForAppUser(appUserId: string, phoneNumber: string) {
  const normalized = normalizePhoneNumber(phoneNumber);

  await db.delete(schema.phoneLinks).where(eq(schema.phoneLinks.appUserId, appUserId));

  await db.insert(schema.phoneLinks).values({
    appUserId,
    phoneNumber: normalized,
  });

  return (await getPhoneLinkForAppUser(appUserId))!;
}

export async function deletePhoneLinkForAppUser(appUserId: string) {
  const before = await getPhoneLinkForAppUser(appUserId);

  await db.delete(schema.phoneLinks).where(eq(schema.phoneLinks.appUserId, appUserId));

  return Boolean(before);
}
