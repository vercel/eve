import type { MessageContent, MessageFilePart } from "#shared/message-content.js";

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

export const DEFAULT_UPLOAD_POLICY: UploadPolicyConfig = Object.freeze({
  allowedMediaTypes: "*",
  maxBytes: 25 * 1024 * 1024,
});

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

export function isUploadsDisabled(policy: UploadPolicy): boolean {
  if (policy === "disabled") return true;
  if (policy.maxBytes === 0) return true;
  if (Array.isArray(policy.allowedMediaTypes) && policy.allowedMediaTypes.length === 0) return true;
  return false;
}

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

export function evaluateFilePart(
  part: MessageFilePart,
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

export function collectUploadPolicyViolations(
  content: MessageContent,
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
