import { z } from "#compiled/zod/index.js";

import type { SessionAuthContext } from "#channel/types.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("channel.forwarded-principal");

export const FORWARDED_BY_ATTRIBUTE = "eve:forwarded-by";

export interface ForwardedPrincipal {
  readonly current: SessionAuthContext;
  readonly initiator?: SessionAuthContext;
}

/**
 * What a forwarder asks the receiving deployment to adopt, passed to
 * {@link TrustedForwarders} next to the verified forwarder.
 */
export interface ForwardedAssertion {
  /**
   * The session principals the forwarder asserts, present when it forwards a
   * principal and absent when only remote parent lineage is being trusted.
   * Both contexts are already stamped with {@link FORWARDED_BY_ATTRIBUTE}, and
   * `initiator` is `current` when the sender omitted it. `initiator` takes
   * effect only on session creation: continuation requests install only
   * `current`, so there `initiator` is the asserted value, not the session's
   * pinned initiator.
   */
  readonly principal?: {
    readonly current: SessionAuthContext;
    readonly initiator: SessionAuthContext;
  };
}

/**
 * Authorizes a transport-authenticated forwarder to supply eve delegation
 * context. Receives the *verified* route-auth principal (who is asserting) and
 * the principals it asserts, so a receiver can limit each forwarder to the
 * identities it may speak for.
 */
export type TrustedForwarders = (
  forwarder: SessionAuthContext,
  assertion: ForwardedAssertion,
) => boolean | Promise<boolean>;

type ForwardedPrincipalParseResult =
  | {
      readonly forwardedPrincipal: ForwardedPrincipal;
      readonly ok: true;
    }
  | {
      readonly cause: unknown;
      readonly message: string;
      readonly ok: false;
    };

type ResolvedForwardedPrincipal =
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

  const current = stampForwardedBy(parsed.forwardedPrincipal.current, input.forwarder.principalId);
  const initiator =
    parsed.forwardedPrincipal.initiator === undefined
      ? current
      : stampForwardedBy(parsed.forwardedPrincipal.initiator, input.forwarder.principalId);

  let accepted: boolean;
  try {
    accepted = await input.trustedForwarders(input.forwarder, {
      principal: { current, initiator },
    });
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

  return { accepted: true, auth: current, initiatorAuth: initiator };
}

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
