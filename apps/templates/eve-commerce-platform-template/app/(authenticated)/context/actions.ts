"use server";

import { patchUserProfile } from "@/lib/shoppers/profile";
import type { UserProfilePatch } from "@/lib/shoppers/profile-schema";
import { requireRequestScope } from "@/lib/auth/next";
import { setAgentName } from "@/lib/shoppers/agent-name";

export async function updateAgentName(name: string) {
  return setAgentName(await requireRequestScope(), name);
}

export async function updatePersonalInfo(patch: UserProfilePatch) {
  await patchUserProfile(await requireRequestScope(), patch);
}
