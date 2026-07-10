import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import Database from "better-sqlite3";

const env = {
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  databasePath: process.env.BETTER_AUTH_DATABASE_PATH,
};

const databasePath = env.databasePath ?? ".data/auth.sqlite";
mkdirSync(dirname(databasePath), { recursive: true });

export const authOptions = {
  baseURL: env.baseURL,
  secret: env.secret,
  database: new Database(databasePath),
  emailAndPassword: { enabled: true },
  session: { cookieCache: { enabled: true } },
  experimental: { joins: true },
} satisfies BetterAuthOptions;

export const auth = betterAuth(authOptions);
