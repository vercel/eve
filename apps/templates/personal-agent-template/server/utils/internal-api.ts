import type { H3Event } from "h3";

export function requireInternalRequest(event: H3Event) {
  const secret = process.env.INTERNAL_API_SECRET?.trim();

  if (!secret) {
    throw createError({
      statusCode: 503,
      statusMessage: "Internal API is not configured",
    });
  }

  const authorization = getRequestHeader(event, "authorization");
  if (authorization !== `Bearer ${secret}`) {
    throw createError({
      statusCode: 401,
      statusMessage: "Unauthorized",
    });
  }
}
