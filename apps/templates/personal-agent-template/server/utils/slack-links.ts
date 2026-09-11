import type { H3Event } from "h3";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import type { SlackLinkRecord, SlackLinkSummary } from "#shared/types/slack-link";

export interface UpsertSlackLinkInput {
  appUserId: string;
  slackTeamId: string;
  slackUserId: string;
  slackUserName?: string;
  slackDisplayName?: string;
  slackEmail?: string;
}

function rowToRecord(row: typeof schema.slackLinks.$inferSelect): SlackLinkRecord {
  return {
    appUserId: row.appUserId,
    slackTeamId: row.slackTeamId,
    slackUserId: row.slackUserId,
    slackUserName: row.slackUserName ?? undefined,
    slackDisplayName: row.slackDisplayName ?? undefined,
    slackEmail: row.slackEmail ?? undefined,
    linkedAt: row.linkedAt,
  };
}

export async function getSlackLinkForMember(teamId: string, userId: string) {
  const [row] = await db
    .select()
    .from(schema.slackLinks)
    .where(
      and(eq(schema.slackLinks.slackTeamId, teamId), eq(schema.slackLinks.slackUserId, userId)),
    )
    .limit(1);

  return row ? rowToRecord(row) : undefined;
}

export async function getSlackLinkForAppUser(appUserId: string) {
  const [row] = await db
    .select()
    .from(schema.slackLinks)
    .where(eq(schema.slackLinks.appUserId, appUserId))
    .limit(1);

  return row ? rowToRecord(row) : undefined;
}

export async function upsertSlackLink(input: UpsertSlackLinkInput) {
  await db.delete(schema.slackLinks).where(eq(schema.slackLinks.appUserId, input.appUserId));

  await db.insert(schema.slackLinks).values({
    appUserId: input.appUserId,
    slackTeamId: input.slackTeamId,
    slackUserId: input.slackUserId,
    slackUserName: input.slackUserName,
    slackDisplayName: input.slackDisplayName,
    slackEmail: input.slackEmail,
  });

  return (await getSlackLinkForAppUser(input.appUserId))!;
}

export async function deleteSlackLinkForAppUser(appUserId: string) {
  const before = await getSlackLinkForAppUser(appUserId);

  await db.delete(schema.slackLinks).where(eq(schema.slackLinks.appUserId, appUserId));

  return Boolean(before);
}

export function toSlackLinkSummary(record?: SlackLinkRecord): SlackLinkSummary {
  if (!record) {
    return { linked: false };
  }

  return {
    linked: true,
    teamId: record.slackTeamId,
    userId: record.slackUserId,
    userName: record.slackUserName,
    displayName: record.slackDisplayName,
    email: record.slackEmail,
    linkedAt: record.linkedAt,
  };
}
