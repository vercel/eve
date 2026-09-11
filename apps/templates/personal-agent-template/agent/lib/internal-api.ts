export function appOrigin() {
  const configured = process.env.BETTER_AUTH_URL?.trim().replace(/\/$/, "");
  if (configured) {
    return configured;
  }

  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) {
    return `https://${vercelUrl}`;
  }

  return "http://localhost:3000";
}

export function internalHeaders() {
  const secret = process.env.INTERNAL_API_SECRET?.trim();
  if (!secret) {
    throw new Error("INTERNAL_API_SECRET is not configured");
  }

  return {
    authorization: `Bearer ${secret}`,
    "content-type": "application/json",
  };
}
