import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import { upsertSlackLink } from "~~/server/utils/slack-links";

const CODE_TTL_MS = 15 * 60 * 1000;

export async function createSlackLinkCode(appUserId: string) {
  await db.delete(schema.slackLinkCodes).where(eq(schema.slackLinkCodes.appUserId, appUserId));

  const code = randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

  await db.insert(schema.slackLinkCodes).values({
    code,
    appUserId,
    expiresAt,
  });

  return { code, expiresAt };
}

export async function getPendingSlackLinkCode(appUserId: string) {
  const [row] = await db
    .select({
      code: schema.slackLinkCodes.code,
      expiresAt: schema.slackLinkCodes.expiresAt,
    })
    .from(schema.slackLinkCodes)
    .where(eq(schema.slackLinkCodes.appUserId, appUserId))
    .orderBy(desc(schema.slackLinkCodes.createdAt))
    .limit(1);

  if (!row) {
    return undefined;
  }

  if (new Date(row.expiresAt).getTime() < Date.now()) {
    await db.delete(schema.slackLinkCodes).where(eq(schema.slackLinkCodes.code, row.code));
    return undefined;
  }

  return { code: row.code, expiresAt: row.expiresAt };
}

export async function consumeSlackLinkCode(input: {
  code: string;
  slackTeamId: string;
  slackUserId: string;
  slackUserName?: string;
  slackDisplayName?: string;
  slackEmail?: string;
}) {
  const normalized = input.code.trim().toUpperCase();

  const [row] = await db
    .select({
      code: schema.slackLinkCodes.code,
      appUserId: schema.slackLinkCodes.appUserId,
      expiresAt: schema.slackLinkCodes.expiresAt,
    })
    .from(schema.slackLinkCodes)
    .where(eq(schema.slackLinkCodes.code, normalized))
    .limit(1);

  if (!row) {
    return { ok: false as const, reason: "invalid" as const };
  }

  if (new Date(row.expiresAt).getTime() < Date.now()) {
    await db.delete(schema.slackLinkCodes).where(eq(schema.slackLinkCodes.code, normalized));
    return { ok: false as const, reason: "expired" as const };
  }

  await upsertSlackLink({
    appUserId: row.appUserId,
    slackTeamId: input.slackTeamId,
    slackUserId: input.slackUserId,
    slackUserName: input.slackUserName,
    slackDisplayName: input.slackDisplayName,
    slackEmail: input.slackEmail,
  });

  await db.delete(schema.slackLinkCodes).where(eq(schema.slackLinkCodes.appUserId, row.appUserId));

  return { ok: true as const, appUserId: row.appUserId };
}
