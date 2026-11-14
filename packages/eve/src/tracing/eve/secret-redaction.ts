import type { SpanExportPolicy } from "#tracing/eve/span-export-policy.js";

export const REDACTED = "[REDACTED]";

// Every attribute that carries model or tool content, under both the GenAI
// semantic-convention names and the AI SDK and eve names that mirror them; a
// secret blocked under one key must not leave under another.
const CONTENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "gen_ai.decision.results",
  "ai.prompt",
  "ai.prompt.messages",
  "ai.response.text",
  "ai.response.reasoning",
  "ai.response.object",
  "ai.response.toolCalls",
  "ai.response.tool_results",
  "ai.toolCall.args",
  "ai.toolCall.result",
  "agent.channel.delivery.input",
  "eve.instructions",
]);

// Prefixed or context-anchored credential formats only: content carries
// arbitrary prose, so a loose pattern would redact ordinary conversation.
// Quantifiers on unanchored runs are bounded so large base64 payloads cannot
// force quadratic scans. No replacement contains a quote or backslash, so
// JSON-encoded values stay parseable.
const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [
    /-----BEGIN[A-Z ]{0,32}PRIVATE KEY-----[A-Za-z0-9+/=\s\\:,]{0,16384}-----END[A-Z ]{0,32}PRIVATE KEY-----/g,
    REDACTED,
  ],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bgh[opsru]_[A-Za-z0-9]{36,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, REDACTED],
  [/\bhf_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bxapp-\d-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(hooks\.slack\.com\/services\/)[A-Za-z0-9_/]{8,}/g, `$1${REDACTED}`],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bSG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,64}/g, REDACTED],
  [/\bvc[piark]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bvercel_blob_rw_[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g, `$1${REDACTED}`],
  [/\b(Authorization["']?\s*[:=]\s*["']?Basic\s+)[A-Za-z0-9+/]{8,}={0,2}/gi, `$1${REDACTED}`],
  [/\b([a-z][a-z0-9+.-]{1,30}:\/\/[^\s:@/"'\\]{1,256}:)[^\s@/"'\\]{1,256}@/gi, `$1${REDACTED}@`],
  [
    /([?&](?:x-amz-signature|x-amz-credential|x-amz-security-token|sig|signature|access_token|token|api_key|apikey|key)=)[^&\s"'#\\]+/gi,
    `$1${REDACTED}`,
  ],
  [/\b((?:AccountKey|SharedAccessKey)=)[A-Za-z0-9+/=]{20,}/g, `$1${REDACTED}`],
];

/** Replaces known credential formats in `text` with {@link REDACTED}. */
export function redactSecrets(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

/** Redacts every string in an event's attributes; returns the event itself when nothing matched. */
export function redactEventSecrets(event: unknown): unknown {
  if (typeof event !== "object" || event === null) return event;
  const attributes = (event as { readonly attributes?: unknown }).attributes;
  if (typeof attributes !== "object" || attributes === null) return event;
  let changed = false;
  const redacted = Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => {
      const next = redactValue(value);
      if (next !== value) changed = true;
      return [key, next];
    }),
  );
  return changed ? { ...event, attributes: redacted } : event;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    const redacted = value.map(redactSecrets);
    return redacted.every((item, index) => item === value[index]) ? value : redacted;
  }
  return value;
}

/**
 * Runs ahead of every destination's own policies, so no exporter, local trace
 * store, or author policy sees a credential that appeared in model or tool
 * content.
 *
 * @internal
 */
export const secretRedactionPolicy: SpanExportPolicy = {
  attribute: ({ key, value }) => {
    if (!CONTENT_ATTRIBUTES.has(key)) return { emit: true };
    const redacted = redactValue(value);
    return redacted === value
      ? { emit: true }
      : { replace: true, value: redacted as string | readonly string[] };
  },
};
