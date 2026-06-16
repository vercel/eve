/**
 * Upload-policy authoring helpers for channel routes.
 */

import type { FilePart, UserContent } from "ai";

import { getKnownByteLength } from "#internal/attachments/data.js";

/**
 * Framework policy for inbound attachments. Either the literal
 * `"disabled"` (reject every attachment) or a structural config.
 */
export type UploadPolicy = "disabled" | UploadPolicyConfig;

/**
 * - `maxBytes` caps the decoded payload size. Zero also rejects every
 *   attachment; negative values are invalid.
 * - `allowedMediaTypes` is either `"*"` or a list of exact or wildcard
 *   patterns. A pattern ending in `/*` matches any subtype (e.g.
 *   `image/*` matches `image/png`).
 */
export interface UploadPolicyConfig {
  readonly maxBytes: number;
  readonly allowedMediaTypes: readonly string[] | "*";
}

/** Author-facing input accepted by channel factories. */
export type UploadPolicyInput = "disabled" | Partial<UploadPolicyConfig>;

/**
 * Framework default: 25 MB cap, unrestricted media types. Channels
 * override this per-route; authors override per-channel /
 * channel factory call via the `uploadPolicy` option.
 */
export const DEFAULT_UPLOAD_POLICY: UploadPolicyConfig = Object.freeze({
  allowedMediaTypes: "*",
  maxBytes: 25 * 1024 * 1024,
});

/**
 * Describes the reason one inbound `FilePart` failed the policy check.
 *
 * Channels use this to produce human-readable error responses
 * (`413 Payload Too Large`, `415 Unsupported Media Type`) or to log and
 * drop individual attachments that should not reach the harness.
 */
export type UploadPolicyViolation =
  | {
      readonly kind: "too-large";
      readonly mediaType: string;
      readonly filename?: string;
      readonly byteLength: number;
      readonly limit: number;
    }
  | {
      readonly kind: "disallowed-media-type";
      readonly mediaType: string;
      readonly filename?: string;
      readonly allowedMediaTypes: readonly string[];
    };

/**
 * Produces a final {@link UploadPolicy} by merging an optional partial
 * override on top of `base` (default: {@link DEFAULT_UPLOAD_POLICY}).
 * Returns `"disabled"` unchanged when passed as the override.
 */
export function mergeUploadPolicy(
  override?: UploadPolicyInput,
  base: UploadPolicyConfig = DEFAULT_UPLOAD_POLICY,
): UploadPolicy {
  if (override === "disabled") return "disabled";
  if (override === undefined) return base;

  const maxBytes = override.maxBytes ?? base.maxBytes;
  const allowedMediaTypes = override.allowedMediaTypes ?? base.allowedMediaTypes;

  if (maxBytes < 0 || !Number.isFinite(maxBytes)) {
    throw new RangeError(
      `UploadPolicy.maxBytes must be a non-negative finite number. Received: ${String(maxBytes)}.`,
    );
  }

  return { allowedMediaTypes, maxBytes };
}

/**
 * Returns `true` when `policy` rejects every attachment — the explicit
 * `"disabled"` literal, `maxBytes: 0`, or an empty `allowedMediaTypes`
 * array. Channels use this to skip attachment-discovery work.
 */
export function isUploadsDisabled(policy: UploadPolicy): boolean {
  if (policy === "disabled") return true;
  if (policy.maxBytes === 0) return true;
  if (Array.isArray(policy.allowedMediaTypes) && policy.allowedMediaTypes.length === 0) return true;
  return false;
}

/**
 * Returns `true` if `mediaType` is accepted under `policy`.
 */
export function isMediaTypeAllowed(mediaType: string, policy: UploadPolicy): boolean {
  if (policy === "disabled") return false;
  if (policy.allowedMediaTypes === "*") {
    return true;
  }

  const normalized = mediaType.toLowerCase();
  for (const pattern of policy.allowedMediaTypes) {
    const normalizedPattern = pattern.toLowerCase();
    if (normalizedPattern === normalized) {
      return true;
    }
    if (normalizedPattern.endsWith("/*")) {
      const prefix = normalizedPattern.slice(0, -1);
      if (normalized.startsWith(prefix)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Evaluates a single `FilePart` against a {@link UploadPolicy}. Returns
 * a {@link UploadPolicyViolation} on rejection, or `null` when the
 * part is either accepted or has a non-local payload (remote URL) whose
 * size cannot be determined without fetching.
 *
 * Order of checks is stable: media-type first (cheap), size second.
 * This keeps channel error responses consistent — a 25 MB disallowed
 * CSV surfaces a 415 instead of a 413 — and mirrors how most HTTP
 * proxies enforce policy.
 */
export function evaluateFilePart(
  part: FilePart,
  policy: UploadPolicy,
): UploadPolicyViolation | null {
  if (policy === "disabled" || !isMediaTypeAllowed(part.mediaType, policy)) {
    const allowedMediaTypes =
      policy === "disabled" || policy.allowedMediaTypes === "*"
        ? []
        : [...policy.allowedMediaTypes];
    const violation: UploadPolicyViolation = {
      allowedMediaTypes,
      kind: "disallowed-media-type",
      mediaType: part.mediaType,
    };
    if (part.filename !== undefined) {
      return { ...violation, filename: part.filename };
    }
    return violation;
  }

  const byteLength = getKnownByteLength(part.data);
  if (byteLength !== null && byteLength > policy.maxBytes) {
    const violation: UploadPolicyViolation = {
      byteLength,
      kind: "too-large",
      limit: policy.maxBytes,
      mediaType: part.mediaType,
    };
    if (part.filename !== undefined) {
      return { ...violation, filename: part.filename };
    }
    return violation;
  }

  return null;
}

/**
 * Walks a `UserContent` array and returns every policy violation, in
 * iteration order. Non-file parts (text, image) are skipped.
 *
 * Returns an empty array when the message is a plain string or when
 * every file part passes. Channels use this to decide between
 * rejecting an inbound request (HTTP) and dropping individual attachments
 * (Slack).
 */
export function collectUploadPolicyViolations(
  content: string | UserContent,
  policy: UploadPolicy,
): readonly UploadPolicyViolation[] {
  if (typeof content === "string") {
    return [];
  }

  const violations: UploadPolicyViolation[] = [];
  for (const part of content) {
    if (part.type !== "file") {
      continue;
    }
    const violation = evaluateFilePart(part, policy);
    if (violation !== null) {
      violations.push(violation);
    }
  }
  return violations;
}

/**
 * Returns a copy of `content` with every {@link FilePart} that violates
 * `policy` removed.
 *
 * Callers that want a hard-fail contract (HTTP) should use
 * {@link collectUploadPolicyViolations} and return a 4xx response
 * instead. Callers that want best-effort delivery (Slack: drop the bad
 * upload, keep the turn going) use this helper and log the dropped
 * attachments.
 */
export function stripDisallowedFileParts(
  content: string | UserContent,
  policy: UploadPolicy,
): string | UserContent {
  if (typeof content === "string") {
    return content;
  }

  const filtered = content.filter((part) => {
    if (part.type !== "file") {
      return true;
    }
    return evaluateFilePart(part, policy) === null;
  });

  return filtered;
}

/**
 * Renders a {@link UploadPolicyViolation} as a short human-readable
 * string. Used by channel error responses and warning logs.
 */
export function formatUploadPolicyViolation(violation: UploadPolicyViolation): string {
  const fileLabel = violation.filename ?? violation.mediaType;
  if (violation.kind === "too-large") {
    return `${fileLabel} (${violation.byteLength} bytes) exceeds the ${violation.limit}-byte upload limit.`;
  }
  const allowed =
    violation.allowedMediaTypes.length > 0
      ? ` Allowed: ${violation.allowedMediaTypes.join(", ")}.`
      : "";
  return `${fileLabel} has media type "${violation.mediaType}" which is not allowed by this route.${allowed}`;
}
