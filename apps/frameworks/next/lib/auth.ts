import { Auth, type AuthConfig } from "@auth/core";
import { getToken } from "@auth/core/jwt";
import { connect } from "@vercel/connect/authjs";
import { authProviders } from "./auth-providers";
export interface AuthJsSession {
  providerId: string;
  issuer: string;
  profile: {
    sub: string;
    name?: string;
    email?: string;
    image?: string;
  };
}

const authConfig: AuthConfig = {
  secret: process.env.AUTH_SECRET,

  basePath: "/auth",

  trustHost: true,

  providers: [
    connect({
      id: authProviders.slack.id,
      name: authProviders.slack.name,
      connector: process.env.SLACK_CONNECTOR!,
    }),
    {
      id: authProviders.vercel.id,
      name: authProviders.vercel.name,
      type: "oidc",
      issuer: "https://vercel.com",
      clientId: process.env.VERCEL_APP_CLIENT_ID!,
      client: { token_endpoint_auth_method: "none" },
      authorization: {
        params: { scope: "openid email profile" },
      },
      checks: ["pkce", "state", "nonce"],
    },
  ],

  callbacks: {
    async jwt(params) {
      const { token, user, account, profile } = params;
      if (account) {
        const sub = account.providerAccountId || profile?.sub || user?.id || token.sub;
        const accessToken = account.access_token;
        if (sub && accessToken) {
          const session: AuthJsSession = {
            providerId: account.provider,
            issuer: account.provider,
            profile: {
              sub,
              name: profile?.name || user?.name || sub,
              email: profile?.email || user?.email || undefined,
              image: profile?.picture || user?.image,
            },
          };
          token.session = session;
        }
      }
      return token;
    },

    async session(params) {
      return params.session;
    },
  },
};

export async function getAuthJsSession(
  request: Request | { headers: Headers | Record<string, string> },
): Promise<AuthJsSession | null> {
  const token = await getToken({
    req: request,
    secret: authConfig.secret,
    secureCookie:
      process.env.VERCEL_ENV !== "development" && process.env.NODE_ENV !== "development",
  });
  const session = token?.session;
  if (session) {
    return session as AuthJsSession;
  }
  return null;
}

export async function authMiddleware(request: Request) {
  return Auth(request, authConfig);
}
