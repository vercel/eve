import { z } from "#compiled/zod/index.js";

import type { SessionAuthContext } from "#channel/types.js";

/**
 * Attribute key the receiving deployment stamps onto accepted forwarded auth
 * contexts. Holds the verified transport caller's `principalId`, always
 * overwriting any sender-supplied value — a forwarder must not be able to
 * falsify the audit trail. On multi-hop chains the attribute names the most
 * recent hop only.
 */
export const FORWARDED_BY_ATTRIBUTE = "eve:forwarded-by";

/**
 * Wire shape of the create-session `forwardedAuth` body field: the
 * dispatching turn's session principals, asserted by a trusted forwarder.
 * Only principal metadata crosses the wire — never tokens or credentials.
 */
export interface ForwardedAuth {
  readonly current: SessionAuthContext;
  readonly initiator?: SessionAuthContext;
}

export type ForwardedAuthParseResult =
  | {
      readonly forwardedAuth: ForwardedAuth;
      readonly ok: true;
    }
  | {
      readonly cause: unknown;
      readonly message: string;
      readonly ok: false;
    };

const attributeValueSchema = z.union([z.string(), z.array(z.string()).readonly()]);

// Strict on keys, deliberately open on `authenticator` / `principalType`
// values: forwarded principals originate from arbitrary channel auth on the
// sending deployment (e.g. `authenticator: "slack-webhook"`), so the wire
// schema must mirror the open public `SessionAuthContext` interface — not the
// narrower runtime enums in `runtime/sessions/auth.ts`.
const forwardedAuthContextSchema = z
  .object({
    attributes: z.record(z.string(), attributeValueSchema).readonly(),
    authenticator: z.string().min(1),
    issuer: z.string().min(1).optional(),
    principalId: z.string().min(1),
    principalType: z.string().min(1),
    subject: z.string().min(1).optional(),
  })
  .strict();

const forwardedAuthSchema = z
  .object({
    current: forwardedAuthContextSchema,
    initiator: forwardedAuthContextSchema.optional(),
  })
  .strict();

/**
 * Parses the create-session `forwardedAuth` body field against the strict
 * wire schema. Mirrors `parseSessionCallback` for `callback`: strict keys,
 * formatted error strings, and no exceptions.
 */
export function parseForwardedAuth(value: unknown): ForwardedAuthParseResult {
  const parsed = forwardedAuthSchema.safeParse(value);
  if (parsed.success) {
    const current = toSessionAuthContext(parsed.data.current);
    return {
      forwardedAuth:
        parsed.data.initiator === undefined
          ? { current }
          : { current, initiator: toSessionAuthContext(parsed.data.initiator) },
      ok: true,
    };
  }

  return {
    cause: parsed.error,
    message: formatForwardedAuthParseError(parsed.error),
    ok: false,
  };
}

/**
 * Returns a copy of `context` with {@link FORWARDED_BY_ATTRIBUTE} set to the
 * verified transport caller's `principalId`, overwriting any sender-supplied
 * value. Attributes never affect Connect token-cache keying (`principalKey`
 * reads only issuer + id), so stamping is purely an audit trail.
 */
export function stampForwardedBy(
  context: SessionAuthContext,
  forwardedBy: string,
): SessionAuthContext {
  return {
    ...context,
    attributes: { ...context.attributes, [FORWARDED_BY_ATTRIBUTE]: forwardedBy },
  };
}

function toSessionAuthContext(
  parsed: z.infer<typeof forwardedAuthContextSchema>,
): SessionAuthContext {
  const context: {
    -readonly [K in keyof SessionAuthContext]: SessionAuthContext[K];
  } = {
    attributes: parsed.attributes,
    authenticator: parsed.authenticator,
    principalId: parsed.principalId,
    principalType: parsed.principalType,
  };
  if (parsed.issuer !== undefined) {
    context.issuer = parsed.issuer;
  }
  if (parsed.subject !== undefined) {
    context.subject = parsed.subject;
  }
  return context;
}

function formatForwardedAuthParseError(error: z.ZodError): string {
  const messages = error.issues.map((issue) => {
    const path =
      issue.path.length === 0 ? "forwardedAuth" : `forwardedAuth.${issue.path.join(".")}`;
    return `${path}: ${issue.message}`;
  });
  return `Invalid forwardedAuth metadata: ${messages.join("; ")}`;
}
