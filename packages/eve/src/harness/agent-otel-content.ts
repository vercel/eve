/**
 * Serializes model and tool payloads into span content attributes for the
 * local trace viewer: prompt messages, the system prompt, responses, and
 * tool arguments/results. Everything is capped so a giant payload cannot
 * bloat a span segment past the reader's per-file limit, and message
 * payloads stay valid JSON through every truncation path.
 */

/** Content attributes are capped so a giant payload cannot bloat a span segment. */
export const CONTENT_ATTRIBUTE_LIMIT = 32 * 1024;

/** Provider transport noise stripped from messages (not tool data). */
const CONTENT_NOISE_KEYS = new Set(["providerOptions", "providerMetadata"]);

/** Marker prepended when oldest messages are dropped to fit the content cap. */
const TRUNCATED_MESSAGES_KEY = "eve.truncated";

/**
 * Serializes one payload value. `strip` removes {@link CONTENT_NOISE_KEYS};
 * pass `false` for tool data, where those keys may be legitimate domain
 * fields the user authored or the tool returned.
 */
export function contentAttribute(value: unknown, strip = true): string | undefined {
  if (value === undefined) return undefined;
  const prepared = strip ? stripContentNoise(value, 0) : value;
  let json: string | undefined;
  try {
    json = JSON.stringify(prepared);
  } catch {
    return undefined;
  }
  if (json === undefined) return undefined;
  return textContentAttribute(json);
}

/**
 * Serializes the prompt messages, keeping the result parseable: oldest
 * messages drop first behind an omission marker, and a single message over
 * the cap is truncated at the text level rather than the JSON level.
 */
export function messagesContentAttribute(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return contentAttribute(messages);
  const stripped = stripContentNoise(messages, 0) as unknown[];
  const full = stringifyContent(stripped);
  if (full !== undefined && full.length <= CONTENT_ATTRIBUTE_LIMIT) return full;
  for (let omitted = 1; omitted < stripped.length; omitted += 1) {
    const json = stringifyContent([
      { [TRUNCATED_MESSAGES_KEY]: { omittedMessages: omitted } },
      ...stripped.slice(omitted),
    ]);
    if (json !== undefined && json.length <= CONTENT_ATTRIBUTE_LIMIT) return json;
  }
  return truncateSingleMessage(stripped);
}

/** Normalizes the AI SDK's `instructions` prompt to plain text for `ai.prompt.system`. */
export function systemPromptAttribute(instructions: unknown): string | undefined {
  if (typeof instructions === "string") return textContentAttribute(instructions);
  if (!isRecord(instructions) && !Array.isArray(instructions)) return undefined;
  const messages = Array.isArray(instructions) ? instructions : [instructions];
  const texts: string[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (typeof message.content === "string") texts.push(message.content);
    else if (Array.isArray(message.content))
      for (const part of message.content)
        if (isRecord(part) && part.type === "text" && typeof part.text === "string")
          texts.push(part.text);
  }
  const joined = texts.join("\n\n").trim();
  return joined.length === 0 ? undefined : textContentAttribute(joined);
}

/** Caps plain text, marking the cut. */
export function textContentAttribute(text: string): string | undefined {
  if (text.length === 0) return undefined;
  return text.length <= CONTENT_ATTRIBUTE_LIMIT
    ? text
    : `${text.slice(0, CONTENT_ATTRIBUTE_LIMIT)}… [truncated]`;
}

function stripContentNoise(value: unknown, depth: number): unknown {
  if (depth > 32 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((e) => stripContentNoise(e, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value))
    if (!CONTENT_NOISE_KEYS.has(k)) out[k] = stripContentNoise(v, depth + 1);
  return out;
}

function truncateSingleMessage(messages: unknown[]): string | undefined {
  if (messages.length === 0) return undefined;
  const last = messages[messages.length - 1];
  if (!isRecord(last)) return undefined;
  const marker = { [TRUNCATED_MESSAGES_KEY]: { omittedMessages: messages.length - 1 } };
  const role = typeof last.role === "string" ? last.role : "user";
  let text = "";
  if (typeof last.content === "string") text = last.content;
  else if (Array.isArray(last.content))
    for (const part of last.content)
      if (isRecord(part) && part.type === "text" && typeof part.text === "string")
        text += (text ? "\n" : "") + part.text;
  for (let len = Math.min(text.length, CONTENT_ATTRIBUTE_LIMIT); len > 0; len -= 256) {
    const cut = len >= text.length ? text : `${text.slice(0, len)}… [truncated]`;
    const json = stringifyContent([marker, { role, content: cut }]);
    if (json !== undefined && json.length <= CONTENT_ATTRIBUTE_LIMIT) return json;
  }
  return stringifyContent([marker, { role, content: "" }]);
}

function stringifyContent(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
