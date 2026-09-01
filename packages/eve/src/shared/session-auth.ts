import { z } from "#compiled/zod/index.js";

/**
 * Runtime-owned authenticator kinds projected into eve session auth metadata.
 */
export type RuntimeSessionAuthenticator = "http-basic" | "jwt-hmac" | "jwt-ecdsa" | "oidc";

/**
 * Normalized principal classifications projected into public session metadata.
 */
export type RuntimeSessionPrincipalType = "service" | "user" | "runtime" | "unknown";

/**
 * Serializable string-only auth attributes preserved on runtime sessions.
 */
export type RuntimeSessionAuthAttributes = Readonly<Record<string, string | readonly string[]>>;

/**
 * Serializable auth context projected onto one runtime session turn.
 */
export type RuntimeSessionAuthContext = z.infer<typeof runtimeSessionAuthContextSchema>;

const runtimeSessionAuthAttributeValueSchema = z.union([
  z.string(),
  z.array(z.string()).readonly(),
]);

/**
 * Zod schema for one serializable runtime session auth context.
 */
const runtimeSessionAuthContextSchema = z
  .object({
    attributes: z.record(z.string(), runtimeSessionAuthAttributeValueSchema).readonly(),
    authenticator: z.enum(["http-basic", "jwt-hmac", "jwt-ecdsa", "oidc"]),
    issuer: z.string().optional(),
    principalId: z.string(),
    principalType: z.enum(["service", "user", "runtime", "unknown"]),
    subject: z.string().optional(),
  })
  .strict();
