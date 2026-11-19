import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { z } from "zod";
import { getAuth } from "./better-auth";
import { accessScopeForUser, type AccessScope } from "@/lib/auth/scope";

const authenticatedSessionSchema = z
  .object({
    user: z
      .object({
        id: z.string().min(1),
        phoneNumber: z.string().min(1),
        phoneNumberVerified: z.literal(true),
      })
      .loose(),
  })
  .loose();

export const readRequestSession = cache(async () => {
  // Mark rendering as request-time before auth initialization touches private Blob.
  const requestHeaders = await headers();
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  const parsed = authenticatedSessionSchema.safeParse(session);
  return parsed.success ? parsed.data : null;
});

export const requireRequestScope = cache(async (): Promise<AccessScope> => {
  const session = await readRequestSession();
  if (!session) throw new UnauthenticatedError();
  return accessScopeForUser(`better-auth:${session.user.id}`);
});

export async function requirePageScope(callbackUrl: string) {
  try {
    return await requireRequestScope();
  } catch (error) {
    if (!(error instanceof UnauthenticatedError)) throw error;
    return redirect(`/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("Sign in to continue.");
    this.name = "UnauthenticatedError";
  }
}
