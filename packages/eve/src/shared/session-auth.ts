import { z } from "#compiled/zod/index.js";

export type RuntimeSessionAuthenticator = "http-basic" | "jwt-hmac" | "jwt-ecdsa" | "oidc";

export type RuntimeSessionPrincipalType = "service" | "user" | "runtime" | "unknown";

export type RuntimeSessionAuthAttributes = Readonly<Record<string, string | readonly string[]>>;

export type RuntimeSessionAuthContext = z.infer<typeof runtimeSessionAuthContextSchema>;

const runtimeSessionAuthAttributeValueSchema = z.union([
  z.string(),
  z.array(z.string()).readonly(),
]);

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
