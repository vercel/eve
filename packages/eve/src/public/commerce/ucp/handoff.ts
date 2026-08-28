/**
 * The checkout-handoff result contract.
 *
 * A UCP checkout response answers one question the application actually
 * has to act on: does the agent keep working in the conversation, does
 * the buyer take over, or is this over? UCP encodes the answer across
 * `status`, `messages[].severity`, `continue_url`, and the embedded
 * service binding. This module collapses those four signals into a
 * single discriminated union so callers switch on `kind` instead of
 * re-deriving the rules.
 */

import {
  parseUcpCheckoutResponse,
  type UcpCheckout,
  type UcpCheckoutStatus,
  type UcpMessage,
  type UcpOrder,
  type UcpServiceBinding,
} from "#public/commerce/ucp/checkout.js";

/** What the agent should do next, in band, without involving the buyer. */
export type UcpConversationalNextStep =
  /** Resolve the blockers and call Update Checkout. */
  | "update"
  /** Everything is collected; call Complete Checkout. */
  | "complete"
  /** The business is placing the order; call Get Checkout until it settles. */
  | "poll";

/** Why the buyer has to take over. */
export type UcpHandoffReason =
  /** The business needs input its API cannot collect. */
  | "requires_buyer_input"
  /** The checkout is complete but the buyer must authorize it. */
  | "requires_buyer_review"
  /** No resource remains to act on programmatically. */
  | "unrecoverable"
  /** The business escalated without naming a buyer-facing severity. */
  | "escalation";

/** Why neither continuation nor handoff is possible. */
export type UcpHandoffFailureReason =
  /** The response was not a UCP checkout body. */
  | "unrecognized_response"
  /** `ucp.status` was `"error"`: the response carries messages, not a checkout. */
  | "protocol_error"
  /** The business escalated but supplied no `continue_url`. */
  | "handoff_unavailable"
  /** A non-2xx response with no usable UCP payload. */
  | "http_error";

interface UcpHandoffBase {
  readonly checkoutId?: string;
  readonly status?: UcpCheckoutStatus;
  /** Every message from the response, in the order the business sent them. */
  readonly messages: readonly UcpMessage[];
  /** Negotiated protocol version from the response envelope. */
  readonly version?: string;
  /** The parsed checkout, absent only when the response could not be parsed. */
  readonly checkout?: UcpCheckout;
}

/** The agent keeps driving the checkout itself. */
export interface UcpConversationalHandoff extends UcpHandoffBase {
  readonly kind: "conversational";
  readonly next: UcpConversationalNextStep;
  /** Errors the agent must clear before `next`, in the spec's processing order. */
  readonly blockers: readonly UcpMessage[];
  /** Available as an early exit even though handoff is not required yet. */
  readonly continueUrl?: string;
}

/** The buyer finishes on the business's own site. */
export interface UcpContinueUrlHandoff extends UcpHandoffBase {
  readonly kind: "continue_url";
  readonly url: string;
  readonly reason: UcpHandoffReason;
}

/** The buyer finishes in the business's checkout embedded in this app. */
export interface UcpEmbeddedHandoff extends UcpHandoffBase {
  readonly kind: "embedded";
  /** `continue_url` with the `ec_*` session parameters applied; load this. */
  readonly url: string;
  /** `continue_url` unmodified, for a redirect fallback. */
  readonly continueUrl: string;
  /** Protocol version pinned for the embedded session's lifetime. */
  readonly protocolVersion: string;
  /** Delegations the business accepted for this session. */
  readonly delegate: readonly string[];
  readonly reason: UcpHandoffReason;
}

/** The order was placed. */
export interface UcpCompletedHandoff extends UcpHandoffBase {
  readonly kind: "completed";
  readonly order?: UcpOrder;
}

/** The session is invalid or expired; start a new one. */
export interface UcpCanceledHandoff extends UcpHandoffBase {
  readonly kind: "canceled";
}

/** Neither continuation nor handoff is possible. */
export interface UcpFailedHandoff extends UcpHandoffBase {
  readonly kind: "failed";
  readonly reason: UcpHandoffFailureReason;
  /** HTTP status, when the response came from a connection tool result. */
  readonly httpStatus?: number;
  /** A `continue_url` the business supplied anyway, if any. */
  readonly continueUrl?: string;
}

/** The resolved next move for one checkout response. */
export type UcpCheckoutHandoff =
  | UcpConversationalHandoff
  | UcpContinueUrlHandoff
  | UcpEmbeddedHandoff
  | UcpCompletedHandoff
  | UcpCanceledHandoff
  | UcpFailedHandoff;

/** Embedded Checkout session parameters this host wants to negotiate. */
export interface UcpEmbeddedCheckoutOptions {
  /**
   * Interactions the host wants to handle natively (e.g.
   * `"payment.credential"`). Intersected with what the business accepted
   * for this session.
   */
  readonly delegate?: readonly string[];
  readonly colorScheme?: "light" | "dark";
  /** Business-defined authentication token for the embedded context. */
  readonly auth?: string;
}

export interface UcpCheckoutHandoffOptions {
  /**
   * Embedded Checkout preferences, or `false` to always hand off by
   * redirect.
   *
   * Embedded checkout is only ever chosen when the business offered it
   * for this specific session, so leaving this set is safe: businesses
   * that do not support it still resolve to `continue_url`.
   */
  readonly embedded?: false | UcpEmbeddedCheckoutOptions;
}

const BUYER_SEVERITIES = new Set(["requires_buyer_input", "requires_buyer_review"]);

const REASON_PRECEDENCE = [
  "requires_buyer_input",
  "requires_buyer_review",
  "unrecoverable",
] as const;

/**
 * Resolves a checkout response into the next move.
 *
 * Accepts a raw checkout body or an eve OpenAPI connection tool result
 * (`{ status, statusText, body }`).
 *
 * The buyer takes over when the business set `status:
 * requires_escalation`, or when any message carries
 * `requires_buyer_input` or `requires_buyer_review` — those two severities
 * mean the buyer must act regardless of the status the business reported.
 * `unrecoverable` on its own does not force a handoff: the spec allows
 * retrying with different inputs, which is conversational work.
 */
export function resolveUcpCheckoutHandoff(
  response: unknown,
  options: UcpCheckoutHandoffOptions = {},
): UcpCheckoutHandoff {
  const parsed = parseUcpCheckoutResponse(response);
  const checkout = parsed.checkout;
  const httpStatus = parsed.httpStatus;

  if (checkout === undefined) {
    return {
      httpStatus,
      kind: "failed",
      messages: [],
      reason: isHttpFailure(httpStatus) ? "http_error" : "unrecognized_response",
    };
  }

  const base: Mutable<UcpHandoffBase> = { checkout, messages: checkout.messages };
  if (checkout.id !== undefined) {
    base.checkoutId = checkout.id;
  }
  if (checkout.status !== undefined) {
    base.status = checkout.status;
  }
  if (checkout.version !== undefined) {
    base.version = checkout.version;
  }

  if (checkout.envelopeStatus === "error") {
    return failed(base, "protocol_error", httpStatus);
  }

  if (checkout.status === undefined) {
    return failed(
      base,
      isHttpFailure(httpStatus) ? "http_error" : "unrecognized_response",
      httpStatus,
    );
  }

  if (checkout.status === "completed") {
    const completed: Mutable<UcpCompletedHandoff> = { ...base, kind: "completed" };
    if (checkout.order !== undefined) {
      completed.order = checkout.order;
    }
    return completed;
  }
  if (checkout.status === "canceled") {
    return { ...base, kind: "canceled" };
  }

  const requiresBuyer =
    checkout.status === "requires_escalation" ||
    checkout.messages.some(
      (message) => message.severity !== undefined && BUYER_SEVERITIES.has(message.severity),
    );

  if (requiresBuyer) {
    if (checkout.continue_url === undefined) {
      return failed(base, "handoff_unavailable", httpStatus);
    }
    return buyerHandoff(base, checkout, checkout.continue_url, options);
  }

  const conversational: Mutable<UcpConversationalHandoff> = {
    ...base,
    blockers: checkout.messages.filter(
      (message) => message.type === "error" && message.severity !== undefined,
    ),
    kind: "conversational",
    next: nextStepFor(checkout.status),
  };
  if (checkout.continue_url !== undefined) {
    conversational.continueUrl = checkout.continue_url;
  }
  return conversational;
}

function nextStepFor(
  status: Exclude<UcpCheckoutStatus, "completed" | "canceled" | "requires_escalation">,
): UcpConversationalNextStep {
  if (status === "ready_for_complete") {
    return "complete";
  }
  if (status === "complete_in_progress") {
    return "poll";
  }
  return "update";
}

function buyerHandoff(
  base: UcpHandoffBase,
  checkout: UcpCheckout,
  continueUrl: string,
  options: UcpCheckoutHandoffOptions,
): UcpContinueUrlHandoff | UcpEmbeddedHandoff {
  const reason = handoffReason(checkout.messages);
  const embedded = options.embedded === undefined ? {} : options.embedded;

  if (embedded !== false) {
    const binding = embeddedBinding(checkout.serviceBindings);
    const protocolVersion = checkout.version ?? binding?.version;
    if (binding !== undefined && protocolVersion !== undefined) {
      const accepted = binding.config?.delegate ?? [];
      const requested = embedded.delegate;
      const delegate =
        requested === undefined ? accepted : accepted.filter((entry) => requested.includes(entry));
      return {
        ...base,
        continueUrl,
        delegate,
        kind: "embedded",
        protocolVersion,
        reason,
        url: embeddedUrl(continueUrl, protocolVersion, delegate, embedded),
      };
    }
  }

  return { ...base, kind: "continue_url", reason, url: continueUrl };
}

/**
 * Finds the embedded binding the business enabled for this session.
 *
 * Service-level discovery only says the business supports embedded
 * checkout; per the spec, availability for a given session is signalled
 * by an embedded binding carrying `config.delegate` in the checkout
 * response itself.
 */
function embeddedBinding(bindings: readonly UcpServiceBinding[]): UcpServiceBinding | undefined {
  return bindings.find(
    (binding) => binding.transport === "embedded" && binding.config?.delegate !== undefined,
  );
}

function embeddedUrl(
  continueUrl: string,
  protocolVersion: string,
  delegate: readonly string[],
  options: UcpEmbeddedCheckoutOptions,
): string {
  const url = new URL(continueUrl);
  url.searchParams.set("ec_version", protocolVersion);
  if (delegate.length > 0) {
    url.searchParams.set("ec_delegate", delegate.join(","));
  }
  if (options.auth !== undefined) {
    url.searchParams.set("ec_auth", options.auth);
  }
  if (options.colorScheme !== undefined) {
    url.searchParams.set("ec_color_scheme", options.colorScheme);
  }
  return url.toString();
}

function handoffReason(messages: readonly UcpMessage[]): UcpHandoffReason {
  for (const severity of REASON_PRECEDENCE) {
    if (messages.some((message) => message.severity === severity)) {
      return severity;
    }
  }
  return "escalation";
}

function isHttpFailure(httpStatus: number | undefined): boolean {
  return httpStatus !== undefined && httpStatus >= 400;
}

function failed(
  base: UcpHandoffBase,
  reason: UcpHandoffFailureReason,
  httpStatus: number | undefined,
): UcpFailedHandoff {
  const result: Mutable<UcpFailedHandoff> = { ...base, kind: "failed", reason };
  if (httpStatus !== undefined) {
    result.httpStatus = httpStatus;
  }
  if (base.checkout?.continue_url !== undefined) {
    result.continueUrl = base.checkout.continue_url;
  }
  return result;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
