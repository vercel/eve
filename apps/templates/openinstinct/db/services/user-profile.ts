import { eq } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  emptyUserProfile,
  parseUserProfile,
  userProfilePatchSchema,
  type UserProfile,
  type UserProfilePatch,
} from "@shared/user-profile/schema";
import { db, userProfiles } from "@db";
import { ensureScope } from "./scope";

const selection = {
  addressLine1: userProfiles.addressLine1,
  addressLine2: userProfiles.addressLine2,
  city: userProfiles.city,
  countryCode: userProfiles.countryCode,
  dateOfBirth: userProfiles.dateOfBirth,
  email: userProfiles.email,
  firstName: userProfiles.firstName,
  lastName: userProfiles.lastName,
  phone: userProfiles.phone,
  postalCode: userProfiles.postalCode,
  region: userProfiles.region,
};

export async function readUserProfile(scope: AccessScope) {
  const rows = await db
    .select(selection)
    .from(userProfiles)
    .where(eq(userProfiles.workspaceId, scope.workspaceId))
    .limit(1);
  return parseUserProfile(rows[0] ?? emptyUserProfile);
}

export async function replaceUserProfile(
  scope: AccessScope,
  input: UserProfile
) {
  await ensureScope(scope);
  const profile = parseUserProfile(input);
  await writeUserProfile(scope, profile);
  return profile;
}

export async function patchUserProfile(
  scope: AccessScope,
  input: UserProfilePatch
) {
  const patch = userProfilePatchSchema.parse(input);
  const profile = parseUserProfile({
    ...(await readUserProfile(scope)),
    ...patch,
  });
  await ensureScope(scope);
  await writeUserProfile(scope, profile);
  return profile;
}

async function writeUserProfile(scope: AccessScope, profile: UserProfile) {
  const updatedAt = new Date();
  await db
    .insert(userProfiles)
    .values({ ...profile, updatedAt, workspaceId: scope.workspaceId })
    .onConflictDoUpdate({
      target: userProfiles.workspaceId,
      set: { ...profile, updatedAt },
    });
}
