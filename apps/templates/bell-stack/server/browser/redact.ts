const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bbb_(?:live|test)_[A-Za-z0-9_-]+\b/g, "[REDACTED_BROWSERBASE_KEY]"],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_MODEL_KEY]"],
  [/\b(?:Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED_TOKEN]"],
  [/(password|secret|token|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]"],
];
const SECRET_FIELD = /^(?:password|secret|token|access_?token|refresh_?token|api_?key|authorization|cookie|set-cookie|totp|totpSecret|otp|cvc|cvv|card_?number)$/i;

export function redactText(value: string): string {
  return SECRET_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value,
  );
}

export function redactValue<T>(value: T): T {
  const json = JSON.stringify(value, function (key, item) {
    if (SECRET_FIELD.test(key)) return "[REDACTED]";
    if (key === "value" && ["fill", "type", "select"].includes(this.action)) return "[value hidden]";
    if (key === "key" && this.action === "press") return "[key hidden]";
    if (typeof item === "string") return redactText(item);
    return item;
  });
  return JSON.parse(json) as T;
}
