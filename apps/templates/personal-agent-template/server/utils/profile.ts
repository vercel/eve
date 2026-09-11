import { eq } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import type { UserProfile, UserProfilePatch, UserProfileWithUser } from "#shared/types/profile";
import {
  deletePhoneLinkForAppUser,
  getPhoneLinkForAppUser,
  upsertPhoneLinkForAppUser,
} from "~~/server/utils/phone-links";

function rowToProfile(row: typeof schema.userProfiles.$inferSelect): UserProfile {
  return {
    userId: row.userId,
    timezone: row.timezone,
    locale: row.locale,
    bio: row.bio,
    updatedAt: row.updatedAt.getTime(),
  };
}

export async function getProfileForUser(userId: string): Promise<UserProfile | undefined> {
  const [row] = await db
    .select()
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId))
    .limit(1);

  return row ? rowToProfile(row) : undefined;
}

export async function getOrCreateProfileForUser(userId: string): Promise<UserProfile> {
  const existing = await getProfileForUser(userId);
  if (existing) {
    return existing;
  }

  await db.insert(schema.userProfiles).values({ userId });

  const created = await getProfileForUser(userId);
  if (!created) {
    throw createError({
      statusCode: 500,
      statusMessage: "Failed to create profile",
    });
  }

  return created;
}

export async function getProfileWithUser(userId: string): Promise<UserProfileWithUser | undefined> {
  const [row] = await db
    .select({
      profile: schema.userProfiles,
      user: schema.user,
    })
    .from(schema.user)
    .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.user.id))
    .where(eq(schema.user.id, userId))
    .limit(1);

  if (!row?.user) {
    return undefined;
  }

  const profile = row.profile ? rowToProfile(row.profile) : await getOrCreateProfileForUser(userId);

  const phoneLink = await getPhoneLinkForAppUser(userId);

  return {
    ...profile,
    name: row.user.name,
    email: row.user.email,
    phoneNumber: phoneLink?.phoneNumber,
  };
}

export async function updateProfileForUser(userId: string, patch: UserProfilePatch) {
  await getOrCreateProfileForUser(userId);

  if (patch.name !== undefined) {
    await db.update(schema.user).set({ name: patch.name.trim() }).where(eq(schema.user.id, userId));
  }

  await db
    .update(schema.userProfiles)
    .set({
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
      ...(patch.bio !== undefined ? { bio: patch.bio } : {}),
    })
    .where(eq(schema.userProfiles.userId, userId));

  if (patch.phoneNumber !== undefined) {
    const phone = patch.phoneNumber?.trim() ?? "";
    if (phone) {
      await upsertPhoneLinkForAppUser(userId, phone);
    } else {
      await deletePhoneLinkForAppUser(userId);
    }
  }

  return getProfileWithUser(userId);
}
