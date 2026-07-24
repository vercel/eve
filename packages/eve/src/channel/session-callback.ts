import { z } from "#compiled/zod/index.js";

import type { SessionCallback, SubagentAuthorizationEvent } from "#channel/types.js";
import { createEveCallbackRoutePath } from "#protocol/routes.js";
import type { JsonValue } from "#shared/json.js";
import { isReservedIpAddress } from "#shared/network-address.js";
import type { TokenUsage } from "#shared/token-usage.js";

/**
 * Status classes a session callback event can carry.
 *
 * The callee POSTs one callback per event to the caller's callback URL;
 * `status` is the coarse class the caller routes on. `"working"`
 * (progress) and `"input_required"` (proxied HITL) are declared so the
 * vocabulary is stable, but are not yet emitted or accepted.
 */
export type SessionCallbackEventStatus =
  | "input_required"
  | "notification"
  | "termination"
  | "working";

/**
 * Terminal callback event: the callee session completed or failed.
 * Exactly one termination event ends every callback stream.
 *
 * `usage` — the callee session's token totals — rides along on completed
 * events so the caller can attribute the callee's spend. Failed events
 * never carry usage.
 */
export type SessionCallbackTerminationEvent =
  | {
      readonly kind: "session.completed";
      readonly output: JsonValue;
      readonly status: "termination";
      readonly usage?: TokenUsage;
    }
  | {
      readonly error: JsonValue;
      readonly kind: "session.failed";
      readonly status: "termination";
    };

/**
 * Informational callback event: a stream event the caller should surface
 * without resolving or blocking the pending call. Carries the callee's
 * authorization lifecycle events — the callback-URL analog of the local
 * subagent adapter's `subagent-authorization-event` forwarding.
 */
export type SessionCallbackNotificationEvent = SubagentAuthorizationEvent & {
  readonly status: "notification";
};

/**
 * One event on the session callback wire contract, discriminated by
 * {@link SessionCallbackEventStatus}.
 */
export type SessionCallbackEvent =
  | SessionCallbackNotificationEvent
  | SessionCallbackTerminationEvent;

/**
 * Body of one callback POST from a callee session to its caller's
 * callback URL. `callId` and `subagentName` correlate the event to the
 * pending caller tool call; `sessionId` is the callee session.
 */
export interface SessionCallbackPayload {
  readonly callId: string;
  readonly event: SessionCallbackEvent;
  readonly sessionId: string;
  readonly subagentName: string;
}

const authorizationChallengeSchema = z.object({
  displayName: z.string().optional(),
  expiresAt: z.string().optional(),
  instructions: z.string().optional(),
  url: z.string().optional(),
  userCode: z.string().optional(),
});

const authorizationRequiredNotificationSchema = z.object({
  data: z.object({
    authorization: authorizationChallengeSchema.optional(),
    description: z.string(),
    name: z.string(),
    sequence: z.number(),
    stepIndex: z.number(),
    turnId: z.string(),
    webhookUrl: z.string().optional(),
  }),
  status: z.literal("notification"),
  type: z.literal("authorization.required"),
});

const authorizationCompletedNotificationSchema = z.object({
  data: z.object({
    authorization: authorizationChallengeSchema.optional(),
    name: z.string(),
    outcome: z.enum(["authorized", "declined", "failed", "timed-out"]),
    reason: z.string().optional(),
    sequence: z.number(),
    stepIndex: z.number(),
    turnId: z.string(),
  }),
  status: z.literal("notification"),
  type: z.literal("authorization.completed"),
});

/**
 * Schema for one `status: "notification"` callback event.
 *
 * The event arrives from a remote callee that may run a different eve
 * version and is re-emitted on the caller's stream, so it is validated
 * to the exact shapes the caller knows how to re-emit; unknown keys are
 * stripped rather than passed through.
 */
export const sessionCallbackNotificationEventSchema: z.ZodType<SessionCallbackNotificationEvent> =
  z.union([authorizationRequiredNotificationSchema, authorizationCompletedNotificationSchema]);

export type SessionCallbackParseResult =
  | {
      readonly callback: SessionCallback;
      readonly ok: true;
    }
  | {
      readonly cause: unknown;
      readonly message: string;
      readonly ok: false;
    };

const sessionCallbackSchema = z
  .object({
    callId: z.string().min(1),
    subagentName: z.string().min(1),
    token: z.string().min(1),
    url: z.string().min(1),
  })
  .strict()
  .superRefine((callback, ctx) => {
    let url: URL;
    try {
      url = new URL(callback.url);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Callback url must be absolute.",
        path: ["url"],
      });
      return;
    }

    if (readCallbackUrlToken(url) !== callback.token) {
      ctx.addIssue({
        code: "custom",
        message: "Callback url token must match callback token.",
        path: ["url"],
      });
    }

    // SSRF guard: the framework POSTs to this URL on session completion, so a
    // caller-supplied private/link-local host (e.g. cloud metadata) must be
    // rejected. The path/token check above does not constrain the host.
    if (isReservedIpAddress(url.hostname)) {
      ctx.addIssue({
        code: "custom",
        message: "Callback url host must not be a private or reserved address.",
        path: ["url"],
      });
    }
  });

export function parseCallbackMetadata(value: unknown): SessionCallbackParseResult {
  const parsed = sessionCallbackSchema.safeParse(value);
  if (parsed.success) {
    return { callback: parsed.data, ok: true };
  }

  return {
    cause: parsed.error,
    message: formatSessionCallbackParseError(parsed.error),
    ok: false,
  };
}

function readCallbackUrlToken(url: URL): string | null {
  // The callback route may be mounted behind a public route prefix (e.g.
  // `/eve/agents/<name>/eve/v1/callback/<token>`), so locate the route
  // suffix instead of anchoring at the path start. `tokenPrefix` begins
  // with `/`, so a match is always segment-aligned.
  const tokenPrefix = createEveCallbackRoutePath("");
  const prefixIndex = url.pathname.lastIndexOf(tokenPrefix);
  if (prefixIndex === -1) {
    return null;
  }

  const encodedToken = url.pathname.slice(prefixIndex + tokenPrefix.length);
  if (encodedToken.length === 0 || encodedToken.includes("/")) {
    return null;
  }

  try {
    return decodeURIComponent(encodedToken);
  } catch {
    return null;
  }
}

function formatSessionCallbackParseError(error: z.ZodError): string {
  const messages = error.issues.map((issue) => {
    const path = issue.path.length === 0 ? "callback" : `callback.${issue.path.join(".")}`;
    return `${path}: ${issue.message}`;
  });
  return `Invalid callback metadata: ${messages.join("; ")}`;
}
