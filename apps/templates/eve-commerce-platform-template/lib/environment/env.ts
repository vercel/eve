import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";
import { isE164PhoneNumber } from "@/lib/auth/phone-number";
import { databaseUrlSchema } from "@/lib/environment/database-url";

export const betterAuthSecretSchema = z
  .string()
  .refine(
    (value) => value.trim().length >= 32,
    "BETTER_AUTH_SECRET must contain at least 32 characters.",
  );

const localDevelopment =
  process.env.NODE_ENV === "development" && process.env.VERCEL_ENV === undefined;

const requiredValue = z.string().refine((value) => value.trim().length > 0, "Required");

const betterAuthUrlSchema = requiredValue.refine(
  (value) => URL.canParse(value),
  "BETTER_AUTH_URL must be an absolute URL",
);

function optionalWithLocalDefault<T extends z.ZodType<string, string>>(
  schema: T,
  localDefault: z.util.NoUndefined<z.output<T>>,
) {
  return localDevelopment ? schema.default(localDefault) : schema.optional();
}

export const env = createEnv({
  server: {
    // Required
    DATABASE_URL: databaseUrlSchema,

    // Optional overrides. Vercel deployments generate the auth secret in their
    // connected private Blob store and derive the URL from system variables.
    BETTER_AUTH_SECRET: optionalWithLocalDefault(
      betterAuthSecretSchema,
      "evey-local-development-auth-secret-0000",
    ),
    BETTER_AUTH_URL: optionalWithLocalDefault(betterAuthUrlSchema, "http://127.0.0.1:3000"),
    EVEY_LOCAL_PHONE_AUTH: z.literal("1").optional(),

    // Browser fallback
    KERNEL_API_KEY: requiredValue.optional(),

    // Shopping
    AGENTCARD_CLIENT_ID: requiredValue.optional(),
    AGENTCARD_CLIENT_SECRET: requiredValue.optional(),
    AGENTCARD_WEBHOOK_SECRET: requiredValue.optional(),

    // Storage
    BLOB_READ_WRITE_TOKEN: requiredValue.optional(),
    BLOB_STORE_ID: requiredValue.optional(),

    // iMessage
    LINQ_CONNECTOR: requiredValue.optional(),
    LINQ_PHONE_NUMBER: requiredValue
      .refine((value) => isE164PhoneNumber(value), "LINQ_PHONE_NUMBER must use E.164 format")
      .optional(),

    // Runtime
    NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
    VERCEL_BRANCH_URL: requiredValue.optional(),
    VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
    VERCEL_PROJECT_ID: requiredValue.optional(),
    VERCEL_PROJECT_PRODUCTION_URL: requiredValue.optional(),
    VERCEL_URL: requiredValue.optional(),
  },
  experimental__runtimeEnv: {},
  emptyStringAsUndefined: true,
});

const authHostname = env.BETTER_AUTH_URL ? new URL(env.BETTER_AUTH_URL).hostname : undefined;

export function isLoopbackHostname(hostname: string | undefined) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

// The documented development command binds to loopback; bypass is explicit.
export const localPhoneAuthBypassEnabled =
  localDevelopment && env.EVEY_LOCAL_PHONE_AUTH === "1" && isLoopbackHostname(authHostname);
