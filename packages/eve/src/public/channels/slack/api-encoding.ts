export function encodeSlackApiBody(body: unknown): {
  readonly body: string;
  readonly contentType: string;
} {
  const params = new URLSearchParams();
  if (body && typeof body === "object") {
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || value === null) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        params.set(key, String(value));
      } else {
        params.set(key, JSON.stringify(value));
      }
    }
  }
  return {
    body: params.toString(),
    contentType: "application/x-www-form-urlencoded",
  };
}

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
