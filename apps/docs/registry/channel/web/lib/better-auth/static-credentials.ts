import type { BetterAuthClientPlugin, BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, formCsrfMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { constantTimeEqual, generateRandomString } from "better-auth/crypto";
import { z } from "zod";

type CredentialValue = string | (() => string | Promise<string>);

export interface StaticCredentialsOptions {
  readonly password: CredentialValue;
  readonly username: CredentialValue;
}

const credentialsSchema = z.object({
  password: z.string(),
});

async function resolveCredential(value: CredentialValue, name: string): Promise<string> {
  const resolved = typeof value === "function" ? await value() : value;
  if (resolved.length === 0) {
    throw new Error(`${name} must be configured before static credential sign-in can be used.`);
  }
  return resolved;
}

/**
 * Adds one configuration-backed password login to Better Auth.
 *
 * The resulting user and session live in Better Auth's signed cookie cache, so
 * this plugin needs no durable database adapter.
 */
export function staticCredentials(options: StaticCredentialsOptions) {
  return {
    id: "static-credentials",
    endpoints: {
      signInStaticCredentials: createAuthEndpoint(
        "/sign-in/static-credentials",
        {
          body: credentialsSchema,
          method: "POST",
          requireHeaders: true,
          use: [formCsrfMiddleware],
        },
        async (ctx) => {
          const [username, expectedPassword] = await Promise.all([
            resolveCredential(options.username, "Static credential username"),
            resolveCredential(options.password, "Static credential password"),
          ]);
          const validPassword = constantTimeEqual(ctx.body.password, expectedPassword);
          if (!validPassword) {
            throw new APIError("UNAUTHORIZED", {
              message: "The password is incorrect.",
            });
          }

          const now = new Date();
          const token = generateRandomString(32, "a-z", "A-Z", "0-9");
          const userId = `static:${username}`;
          const expiresAt = new Date(now.getTime() + ctx.context.sessionConfig.expiresIn * 1_000);
          const user = {
            createdAt: now,
            email: `${encodeURIComponent(username)}@static.invalid`,
            emailVerified: true,
            id: userId,
            image: null,
            name: username,
            updatedAt: now,
          };
          const session = {
            createdAt: now,
            expiresAt,
            id: token,
            ipAddress: ctx.request?.headers.get("x-forwarded-for") ?? null,
            token,
            updatedAt: now,
            userAgent: ctx.request?.headers.get("user-agent") ?? null,
            userId,
          };

          await setSessionCookie(ctx, { session, user });
          return ctx.json({ user });
        },
      ),
    },
    rateLimit: [
      {
        max: 5,
        pathMatcher: (path: string) => path === "/sign-in/static-credentials",
        window: 60,
      },
    ],
  } satisfies BetterAuthPlugin;
}

/** Adds the typed `signIn.staticCredentials` action to the Better Auth client. */
export function staticCredentialsClient() {
  return {
    $InferServerPlugin: {} as ReturnType<typeof staticCredentials>,
    atomListeners: [
      {
        matcher: (path: string) => path === "/sign-in/static-credentials",
        signal: "$sessionSignal",
      },
    ],
    id: "static-credentials",
  } satisfies BetterAuthClientPlugin;
}
