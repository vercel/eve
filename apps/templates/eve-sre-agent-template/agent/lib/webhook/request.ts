import { createHash, timingSafeEqual } from "node:crypto";

const SECRET_HEADER = "x-sre-webhook-secret";
const BEARER_AUTH = /^Bearer\s+(.+)$/iu;

export function readWebhookSecret(headers: Headers): string | null {
  const direct = headers.get(SECRET_HEADER)?.trim();
  if (direct) {
    return direct;
  }

  const authorization = headers.get("authorization");
  const match = authorization?.match(BEARER_AUTH);
  return match?.[1]?.trim() || null;
}

export function verifyWebhookSecret(
  headers: Headers,
  expected: string | undefined
): boolean {
  const actual = readWebhookSecret(headers);
  if (!(actual && expected)) {
    return false;
  }

  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export type WebhookJsonResult =
  | { ok: true; raw: unknown }
  | { ok: false; response: Response };

export async function readWebhookJson(
  request: Request,
  expectedSecret: string | undefined
): Promise<WebhookJsonResult> {
  if (!verifyWebhookSecret(request.headers, expectedSecret)) {
    return {
      ok: false,
      response: new Response("unauthorized", { status: 401 }),
    };
  }

  try {
    return { ok: true, raw: await request.json() };
  } catch {
    return {
      ok: false,
      response: new Response("invalid JSON body", { status: 400 }),
    };
  }
}
