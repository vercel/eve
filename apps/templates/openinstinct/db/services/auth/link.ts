import { runWithAdapter } from "@better-auth/core/context";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq, gt } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { account, db, session, user, verification } from "@db";
import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";
import { getAuth } from "@db/services/auth";

export function linkConfigured() {
  return Boolean(
    env.LINK_CLIENT_ID && env.LINK_CLIENT_SECRET && env.STRIPE_PUBLISHABLE_KEY
  );
}

export class LinkConnectionRequiredError extends Error {
  constructor() {
    super("Connect your Link wallet to continue.");
    this.name = "LinkConnectionRequiredError";
  }
}

export async function getLinkAccount(userId: string) {
  const [result] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "link")))
    .limit(1);
  return result;
}

// Refresh-token rotation and disconnection share the same database lock.
async function withLinkAccount<T>(
  userId: string,
  operation: (accountId: string) => Promise<T>
) {
  const auth = await getAuth();
  return db.transaction(async (tx) => {
    const [saved] = await tx
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, "link")))
      .for("update");
    if (!saved) throw new LinkConnectionRequiredError();
    return runWithAdapter(
      drizzleAdapter(tx, {
        provider: "pg",
        schema: { account, session, user, verification },
      })(auth.options),
      () => operation(saved.id)
    );
  });
}

export async function getLinkToken(userId: string) {
  if (!linkConfigured())
    throw new Error("Link is not configured on this installation.");
  try {
    return await withLinkAccount(userId, async (accountId) => {
      const auth = await getAuth();
      const result = await auth.api.getAccessToken({
        body: { userId, accountId },
      });
      if (!result.accessToken) throw new LinkConnectionRequiredError();
      return {
        token: result.accessToken,
        expiresAt: result.accessTokenExpiresAt?.getTime(),
      };
    });
  } catch (error) {
    if (error instanceof LinkConnectionRequiredError) throw error;
    if (
      error instanceof APIError &&
      (error.statusCode === 400 || error.statusCode === 401)
    ) {
      throw new LinkConnectionRequiredError();
    }
    // oxlint-disable-next-line eslint/preserve-caught-error -- Provider errors can contain tokens and response bodies; keep them out of Eve events.
    throw new Error("Link is temporarily unavailable. Try again shortly.");
  }
}

export async function disconnectLink(userId: string, headers: Headers) {
  return withLinkAccount(userId, async (accountId) => {
    const auth = await getAuth();
    return auth.api.disconnectLink({ body: { accountId }, headers });
  });
}

function authorizationIdentifier(userId: string, attempt: string) {
  return `link-eve:${JSON.stringify([userId, z.uuid().parse(attempt)])}`;
}

export async function startLinkAuthorization(
  userId: string,
  callbackUrl: string
) {
  const target = new URL(callbackUrl);
  if (
    target.origin !== applicationOrigin() ||
    !target.pathname.startsWith("/eve/v1/connections/")
  ) {
    throw new Error("Invalid Link authorization callback.");
  }
  const attempt = randomUUID();
  target.searchParams.set("attempt", attempt);
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await db.insert(verification).values({
    id: randomUUID(),
    identifier: authorizationIdentifier(userId, attempt),
    value: target.href,
    expiresAt,
  });
  return { attempt, expiresAt: expiresAt.toISOString() };
}

export async function linkAuthorizationCallback(
  userId: string,
  attempt: string
) {
  const [pending] = await db
    .select({ value: verification.value })
    .from(verification)
    .where(
      and(
        eq(verification.identifier, authorizationIdentifier(userId, attempt)),
        gt(verification.expiresAt, new Date())
      )
    )
    .limit(1);
  if (!pending)
    throw new Error(
      "Link connection expired. Start again from your conversation."
    );
  return pending.value;
}

export async function consumeLinkAuthorization(
  userId: string,
  attempt: string
) {
  const [pending] = await db
    .delete(verification)
    .where(
      and(
        eq(verification.identifier, authorizationIdentifier(userId, attempt)),
        gt(verification.expiresAt, new Date())
      )
    )
    .returning({ id: verification.id });
  return Boolean(pending);
}
