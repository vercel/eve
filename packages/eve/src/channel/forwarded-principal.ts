import { z } from "#compiled/zod/index.js";

import type { SessionAuthContext } from "#channel/types.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("channel.forwarded-principal");

/**
 * Attribute key the receiving deployment stamps onto accepted forwarded
 * principal contexts. Holds the verified transport forwarder's `principalId`,
 * always overwriting any sender-supplied value — a forwarder must not be able
 * to falsify the audit trail. On multi-hop chains the attribute names the
 * most recent hop only.
 */
export const FORWARDED_BY_ATTRIBUTE = "eve:forwarded-by";

/**
 * Wire shape of the create-session `forwardedPrincipal` body field: the
 * dispatching turn's session principals, asserted by a trusted forwarder.
 * Only principal metadata crosses the wire — never tokens or credentials.
 */
export interface ForwardedPrincipal {
  readonly current: SessionAuthContext;
  readonly initiator?: SessionAuthContext;
}

/**
 * Authorizes which transport-authenticated forwarders may assert a forwarded
 * principal. Receives the *verified* route-auth principal (who is asserting),
 * never the forwarded identity (what is asserted).
 */
export type TrustedForwarders = (forwarder: SessionAuthContext) => boolean | Promise<boolean>;

export type ForwardedPrincipalParseResult =
  | {
      readonly forwardedPrincipal: ForwardedPrincipal;
      readonly ok: true;
    }
  | {
      readonly cause: unknown;
      readonly message: string;
      readonly ok: false;
    };

/**
 * The create route's effective session principals after the forwarded
 * principal gate: the transport principal untouched when the body carries no
 * assertion, or the stamped forwarded contexts once a trusted forwarder's
 * assertion is accepted.
 */
export type ResolvedForwardedPrincipal =
  | {
      readonly accepted: false;
      readonly auth: SessionAuthContext;
    }
  | {
      readonly accepted: true;
      readonly auth: SessionAuthContext;
      readonly initiatorAuth: SessionAuthContext;
    };

const attributeValueSchema = z.union([z.string(), z.array(z.string()).readonly()]);

// Strict on keys, deliberately open on `authenticator` / `principalType`
// values: forwarded principals originate from arbitrary channel auth on the
// sending deployment (e.g. `authenticator: "slack-webhook"`), so the wire
// schema must mirror the open public `SessionAuthContext` interface — not the
// narrower runtime enums in `runtime/sessions/auth.ts`.
const forwardedPrincipalContextSchema = z
  .object({
    attributes: z.record(z.string(), attributeValueSchema).readonly(),
    authenticator: z.string().min(1),
    issuer: z.string().min(1).optional(),
    principalId: z.string().min(1),
    principalType: z.string().min(1),
    subject: z.string().min(1).optional(),
  })
  .strict();

const forwardedPrincipalSchema = z
  .object({
    current: forwardedPrincipalContextSchema,
    initiator: forwardedPrincipalContextSchema.optional(),
  })
  .strict();

/**
 * Gates the create-session `forwardedPrincipal` body field and resolves the
 * effective session principals. Returns the failure `Response` on rejection:
 * 403 when the channel accepts no forwarded principal or the predicate
 * refuses the forwarder, 400 on a malformed payload, 500 when the authored
 * predicate throws. Accepted contexts are stamped with
 * {@link FORWARDED_BY_ATTRIBUTE} before they are returned, so a custom
 * `onMessage` always sees the transport forwarder on the replaced principal.
 */
export async function resolveForwardedPrincipal(input: {
  readonly trustedForwarders: TrustedForwarders | undefined;
  readonly forwarder: SessionAuthContext;
  readonly payload: Record<string, unknown>;
}): Promise<ResolvedForwardedPrincipal | Response> {
  const value = input.payload.forwardedPrincipal;
  if (value === undefined) return { accepted: false, auth: input.forwarder };

  if (input.trustedForwarders === undefined) {
    return Response.json(
      { error: "This deployment does not accept a forwarded principal.", ok: false },
      { status: 403 },
    );
  }

  const parsed = parseForwardedPrincipal(value);
  if (!parsed.ok) {
    return Response.json({ error: parsed.message, ok: false }, { status: 400 });
  }

  let accepted: boolean;
  try {
    accepted = await input.trustedForwarders(input.forwarder);
  } catch (error) {
    const errorId = logError(log, "trustedForwarders handler failed", error, {
      forwarder: input.forwarder.principalId,
    });
    return Response.json(
      { error: "trustedForwarders handler failed.", errorId, ok: false },
      { status: 500 },
    );
  }
  if (!accepted) {
    return Response.json(
      { error: "Caller is not authorized to assert a forwarded principal.", ok: false },
      { status: 403 },
    );
  }

  const current = stampForwardedBy(parsed.forwardedPrincipal.current, input.forwarder.principalId);
  const initiator =
    parsed.forwardedPrincipal.initiator === undefined
      ? current
      : stampForwardedBy(parsed.forwardedPrincipal.initiator, input.forwarder.principalId);
  return { accepted: true, auth: current, initiatorAuth: initiator };
}

/**
 * Parses the create-session `forwardedPrincipal` body field against the
 * strict wire schema. Mirrors `parseSessionCallback` for `callback`: strict
 * keys, formatted error strings, and no exceptions.
 */
export function parseForwardedPrincipal(value: unknown): ForwardedPrincipalParseResult {
  const parsed = forwardedPrincipalSchema.safeParse(value);
  if (parsed.success) {
    const current = toSessionAuthContext(parsed.data.current);
    return {
      forwardedPrincipal:
        parsed.data.initiator === undefined
          ? { current }
          : { current, initiator: toSessionAuthContext(parsed.data.initiator) },
      ok: true,
    };
  }

  return {
    cause: parsed.error,
    message: formatForwardedPrincipalParseError(parsed.error),
    ok: false,
  };
}

/**
 * Returns a copy of `context` with {@link FORWARDED_BY_ATTRIBUTE} set to the
 * verified transport forwarder's `principalId`, overwriting any
 * sender-supplied value. Attributes never affect Connect token-cache keying
 * (`principalKey` reads only issuer + id), so stamping is purely an audit
 * trail.
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
  parsed: z.infer<typeof forwardedPrincipalContextSchema>,
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

function formatForwardedPrincipalParseError(error: z.ZodError): string {
  const messages = error.issues.map((issue) => {
    const path =
      issue.path.length === 0 ? "forwardedPrincipal" : `forwardedPrincipal.${issue.path.join(".")}`;
    return `${path}: ${issue.message}`;
  });
  return `Invalid forwardedPrincipal metadata: ${messages.join("; ")}`;
}
