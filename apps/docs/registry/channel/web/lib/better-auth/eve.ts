import type { User as BetterAuthUser } from "better-auth";
import type { AuthFn } from "eve/channels/auth";

interface BetterAuthSessionReader<User extends BetterAuthUser> {
  readonly api: {
    getSession(options: { headers: Headers }): Promise<null | { user: User }>;
  };
}

export interface FromBetterAuthOptions<User extends BetterAuthUser> {
  readonly attributes?: (input: {
    request: Request;
    user: User;
  }) => Readonly<Record<string, string>>;
}

/**
 * Converts a Better Auth session into eve's authenticated user context.
 */
export function fromBetterAuth<User extends BetterAuthUser>(
  betterAuth: BetterAuthSessionReader<User>,
  options: FromBetterAuthOptions<User> = {},
): AuthFn<Request> {
  return async (request) => {
    const session = await betterAuth.api.getSession({ headers: request.headers });
    if (!session) return null;

    const attributes: Record<string, string> = {
      email: session.user.email,
      name: session.user.name,
      ...options.attributes?.({ request, user: session.user }),
    };
    if (session.user.image) attributes.image = session.user.image;

    return {
      attributes,
      authenticator: "better-auth",
      issuer: new URL(request.url).origin,
      principalId: session.user.id,
      principalType: "user",
      subject: session.user.id,
    };
  };
}
