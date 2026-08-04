import { betterAuth } from "better-auth/minimal";
import { staticCredentials } from "@/lib/better-auth/static-credentials";

const DEVELOPMENT_PASSWORD = "eve";

const isDevelopment = process.env.NODE_ENV === "development";
const password =
  process.env.EVE_ACCESS_PASSWORD ?? (isDevelopment ? DEVELOPMENT_PASSWORD : undefined);
const hasAuthSecret = isDevelopment || Boolean(process.env.BETTER_AUTH_SECRET);

export const auth =
  password && hasAuthSecret
    ? betterAuth({
        plugins: [
          staticCredentials({
            username: "eve",
            password,
          }),
        ],
        session: {
          cookieCache: {
            enabled: true,
            strategy: "jwe",
          },
        },
      })
    : null;
