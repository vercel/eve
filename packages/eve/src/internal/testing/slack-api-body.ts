/** Decodes a Slack Web API request body captured from a mocked `fetch`. */
export function decodeSlackApiBody(body: unknown, contentType: string | null): unknown {
  if (typeof body !== "string") return body;
  if (contentType?.includes("application/json")) return parseJson(body);
  if (!contentType?.includes("application/x-www-form-urlencoded")) return body;

  const parsed: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    parsed[key] = value.startsWith("[") || value.startsWith("{") ? parseJson(value) : value;
  }
  return parsed;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
