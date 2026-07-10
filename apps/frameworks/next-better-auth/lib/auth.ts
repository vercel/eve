import { betterAuth, type BetterAuthOptions } from "better-auth";
import Database from "better-sqlite3";

const env = {
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  databasePath: process.env.BETTER_AUTH_DATABASE_PATH,
};

export const authOptions = {
  baseURL: env.baseURL,
  secret: env.secret,
  database: new Database(env.databasePath ?? ".data/auth.sqlite"),
  emailAndPassword: { enabled: true },
  session: { cookieCache: { enabled: true } },
  experimental: { joins: true },
} satisfies BetterAuthOptions;

export const auth = betterAuth(authOptions);
