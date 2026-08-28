/**
 * Minimal typed projection of a UCP checkout response.
 *
 * This is deliberately not a full model of the checkout schema: it types
 * only the fields the handoff decision reads, and carries everything
 * else through untouched on {@link UcpCheckout.raw}. Extensions add
 * fields to checkout responses continuously, and a partial projection
 * that never has to be exhaustive is the one that keeps working.
 */

import { isObject } from "#shared/guards.js";

/** Checkout lifecycle phase set by the business. */
export type UcpCheckoutStatus =
  | "incomplete"
  | "requires_escalation"
  | "ready_for_complete"
  | "complete_in_progress"
  | "completed"
  | "canceled";

/**
 * Recommended platform action for one error message.
 *
 * `recoverable` is the only severity a platform can clear on its own;
 * the other three all mean the buyer has to be brought in.
 */
export type UcpErrorSeverity =
  | "recoverable"
  | "requires_buyer_input"
  | "requires_buyer_review"
  | "unrecoverable";

/** One entry of a checkout response's `messages` array. */
export interface UcpMessage {
  readonly type: "error" | "warning" | "info";
  readonly code?: string;
  readonly content?: string;
  readonly content_type?: "plain" | "markdown";
  /** RFC 9535 JSONPath pointing at the component the message is about. */
  readonly path?: string;
  /** Present on `type: "error"`. */
  readonly severity?: UcpErrorSeverity;
}

/** A transport binding the business declared for this checkout session. */
export interface UcpServiceBinding {
  readonly transport?: string;
  readonly version?: string;
  readonly endpoint?: string;
  readonly config?: {
    /** Delegations the business accepted for this session. */
    readonly delegate?: readonly string[];
  };
}

/** The order a completed checkout carries. */
export interface UcpOrder {
  readonly id?: string;
  readonly permalink_url?: string;
}

/** Typed projection of one checkout response body. */
export interface UcpCheckout {
  readonly id?: string;
  readonly status?: UcpCheckoutStatus;
  /** Absolute HTTPS URL the buyer can be handed off to. */
  readonly continue_url?: string;
  readonly messages: readonly UcpMessage[];
  readonly order?: UcpOrder;
  readonly expires_at?: string;
  /** Negotiated protocol version from the response envelope. */
  readonly version?: string;
  /** `ucp.status` — the envelope's shape discriminator. */
  readonly envelopeStatus?: "success" | "error";
  /** `ucp.services["dev.ucp.shopping"]` bindings, if any. */
  readonly serviceBindings: readonly UcpServiceBinding[];
  /** The response body exactly as received. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** The eve OpenAPI connection tool result shape. */
interface HttpToolResult {
  readonly status: number;
  readonly statusText?: string;
  readonly body: unknown;
}

/** A checkout response paired with the HTTP status it arrived with. */
export interface ParsedUcpCheckoutResponse {
  readonly checkout?: UcpCheckout;
  /** Present when the value came from an eve OpenAPI connection tool result. */
  readonly httpStatus?: number;
}

const SHOPPING_SERVICE = "dev.ucp.shopping";

const CHECKOUT_STATUSES = new Set<string>([
  "incomplete",
  "requires_escalation",
  "ready_for_complete",
  "complete_in_progress",
  "completed",
  "canceled",
]);

const SEVERITIES = new Set<string>([
  "recoverable",
  "requires_buyer_input",
  "requires_buyer_review",
  "unrecoverable",
]);

/**
 * Parses a checkout response.
 *
 * Accepts either a raw checkout body or an eve OpenAPI connection tool
 * result (`{ status, statusText, body }`), so the same call works whether
 * you hold the connection tool's output or a body you fetched yourself.
 * `checkout` is absent when the value is not a JSON object.
 */
export function parseUcpCheckoutResponse(value: unknown): ParsedUcpCheckoutResponse {
  if (isHttpToolResult(value)) {
    const checkout = parseCheckoutBody(value.body);
    return checkout === undefined
      ? { httpStatus: value.status }
      : { checkout, httpStatus: value.status };
  }
  const checkout = parseCheckoutBody(value);
  return checkout === undefined ? {} : { checkout };
}

function isHttpToolResult(value: unknown): value is HttpToolResult {
  return isObject(value) && typeof value.status === "number" && "body" in value;
}

function parseCheckoutBody(value: unknown): UcpCheckout | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const envelope = isObject(value.ucp) ? value.ucp : undefined;
  const result: {
    -readonly [K in keyof UcpCheckout]: UcpCheckout[K];
  } = {
    messages: parseMessages(value.messages),
    raw: value,
    serviceBindings: parseServiceBindings(envelope?.services),
  };

  if (typeof value.id === "string") {
    result.id = value.id;
  }
  if (typeof value.status === "string" && CHECKOUT_STATUSES.has(value.status)) {
    result.status = value.status as UcpCheckoutStatus;
  }
  if (typeof value.continue_url === "string") {
    result.continue_url = value.continue_url;
  }
  if (typeof value.expires_at === "string") {
    result.expires_at = value.expires_at;
  }
  if (isObject(value.order)) {
    const order: { id?: string; permalink_url?: string } = {};
    if (typeof value.order.id === "string") {
      order.id = value.order.id;
    }
    if (typeof value.order.permalink_url === "string") {
      order.permalink_url = value.order.permalink_url;
    }
    result.order = order;
  }
  if (typeof envelope?.version === "string") {
    result.version = envelope.version;
  }
  if (envelope?.status === "success" || envelope?.status === "error") {
    result.envelopeStatus = envelope.status;
  }

  return result;
}

function parseMessages(value: unknown): readonly UcpMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const messages: UcpMessage[] = [];
  for (const entry of value) {
    if (!isObject(entry)) {
      continue;
    }
    const type = entry.type;
    if (type !== "error" && type !== "warning" && type !== "info") {
      continue;
    }
    const message: {
      -readonly [K in keyof UcpMessage]: UcpMessage[K];
    } = { type };
    if (typeof entry.code === "string") {
      message.code = entry.code;
    }
    if (typeof entry.content === "string") {
      message.content = entry.content;
    }
    if (entry.content_type === "plain" || entry.content_type === "markdown") {
      message.content_type = entry.content_type;
    }
    if (typeof entry.path === "string") {
      message.path = entry.path;
    }
    if (typeof entry.severity === "string" && SEVERITIES.has(entry.severity)) {
      message.severity = entry.severity as UcpErrorSeverity;
    }
    messages.push(message);
  }
  return messages;
}

function parseServiceBindings(value: unknown): readonly UcpServiceBinding[] {
  if (!isObject(value) || !Array.isArray(value[SHOPPING_SERVICE])) {
    return [];
  }
  const bindings: UcpServiceBinding[] = [];
  for (const entry of value[SHOPPING_SERVICE]) {
    if (!isObject(entry)) {
      continue;
    }
    const binding: {
      -readonly [K in keyof UcpServiceBinding]: UcpServiceBinding[K];
    } = {};
    if (typeof entry.transport === "string") {
      binding.transport = entry.transport;
    }
    if (typeof entry.version === "string") {
      binding.version = entry.version;
    }
    if (typeof entry.endpoint === "string") {
      binding.endpoint = entry.endpoint;
    }
    if (isObject(entry.config)) {
      const delegate = entry.config.delegate;
      binding.config = Array.isArray(delegate)
        ? { delegate: delegate.filter((item): item is string => typeof item === "string") }
        : {};
    }
    bindings.push(binding);
  }
  return bindings;
}
