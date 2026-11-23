import { createHash } from "node:crypto";

export interface AccessScope {
  readonly userId: string;
  // Stable partition for eve memory, browser profiles, and private Blob paths.
  // SQL ownership is keyed directly by userId.
  readonly workspaceId: string;
}

export function accessScopeForUser(userId: string): AccessScope {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) throw new Error("An authenticated user is required.");

  return {
    userId: normalizedUserId,
    workspaceId: `personal:${createHash("sha256")
      .update(normalizedUserId)
      .digest("hex")
      .slice(0, 32)}`,
  };
}

// The fixed shopper that local `eve dev` sessions and evals act as.
export const localDeveloperUserId = "local:developer";
