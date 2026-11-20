import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { shoppers } from "@/lib/db/schema";
import type { AccessScope } from "@/lib/auth/scope";
import {
  emptyUserProfile,
  parseUserProfile,
  userProfilePatchSchema,
  type UserProfilePatch,
} from "@/lib/shoppers/profile-schema";

const selection = {
  addressLine1: shoppers.addressLine1,
  addressLine2: shoppers.addressLine2,
  city: shoppers.city,
  countryCode: shoppers.countryCode,
  dateOfBirth: shoppers.dateOfBirth,
  email: shoppers.email,
  firstName: shoppers.firstName,
  lastName: shoppers.lastName,
  phone: shoppers.phone,
  postalCode: shoppers.postalCode,
  region: shoppers.region,
};

export async function readUserProfile(scope: AccessScope) {
  const [profile] = await db
    .select(selection)
    .from(shoppers)
    .where(eq(shoppers.id, scope.userId))
    .limit(1);
  return parseUserProfile(profile ?? emptyUserProfile);
}

export async function patchUserProfile(scope: AccessScope, input: UserProfilePatch) {
  const patch = userProfilePatchSchema.parse(input);
  if (patch.countryCode) patch.countryCode = patch.countryCode.toUpperCase();
  return saveProfile(scope, patch);
}

// Only update supplied fields so parallel edits don't overwrite one another.
async function saveProfile(scope: AccessScope, fields: UserProfilePatch) {
  const [profile] = await db
    .insert(shoppers)
    .values({ ...fields, id: scope.userId })
    .onConflictDoUpdate({ target: shoppers.id, set: fields })
    .returning(selection);
  if (!profile) throw new Error("Unable to save personal information.");
  return parseUserProfile(profile);
}
