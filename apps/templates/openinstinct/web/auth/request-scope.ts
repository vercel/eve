import { headers } from "next/headers";
import { cache } from "react";
import { getAuthSession } from "@db/services/auth/session";
import {
  accessScopeForUser,
  type AccessScope,
} from "@shared/identity/access-scope";

export const requireRequestScope = cache(async (): Promise<AccessScope> => {
  const session = await getAuthSession(await headers());
  if (!session) throw new UnauthenticatedError();
  return accessScopeForUser(`better-auth:${session.user.id}`);
});

export class UnauthenticatedError extends Error {
  constructor() {
    super("Sign in to continue.");
    this.name = "UnauthenticatedError";
  }
}
