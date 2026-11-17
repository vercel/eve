export const EVE_ATTRIBUTE_VALUE_MAX_BYTES = 256;

export type EveAttributeValue = string | number | boolean | undefined;

export function truncateForTag(value: string, maxBytes = EVE_ATTRIBUTE_VALUE_MAX_BYTES): string {
  if (maxBytes <= 0) {
    return "";
  }

  const encoder = new TextEncoder();
  const fullBytes = encoder.encode(value);
  if (fullBytes.length <= maxBytes) {
    return value;
  }

  let end = value.length;
  while (end > 0) {
    const lastCharCode = value.charCodeAt(end - 1);
    const endsOnHighSurrogate = lastCharCode >= 0xd800 && lastCharCode <= 0xdbff;
    if (endsOnHighSurrogate) {
      end -= 1;
      continue;
    }
    const candidate = value.slice(0, end);
    if (encoder.encode(candidate).length <= maxBytes) {
      return candidate;
    }
    end -= 1;
  }
  return "";
}

export function normalizeEveAttributes(
  attrs: Record<string, EveAttributeValue>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) {
      continue;
    }
    const stringValue = typeof value === "string" ? value : String(value);
    normalized[key] = truncateForTag(stringValue);
  }
  return normalized;
}
