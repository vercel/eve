import { createHmac, timingSafeEqual } from "node:crypto";

// The sign-in page takes the admin token, or a ticket eve mints for a
// meeting's chat: signed with that token and valid for a few minutes, so
// people in the meeting never see the token itself.

const TICKET_MINUTES = 15;

export const SIGN_IN_PATH = "/meeting/browser-sign-in";

export function adminToken(): string | undefined {
  return process.env.MEETING_ADMIN_TOKEN?.trim() || undefined;
}

function sign(expires: string, token: string): string {
  return createHmac("sha256", token).update(`browser-sign-in:${expires}`).digest("hex");
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A sign-in page link that works for {@link TICKET_MINUTES} minutes. */
export function signInLink(): { url: string; minutes: number } {
  const token = adminToken();
  if (!token) throw new Error("The sign-in page is off: set MEETING_ADMIN_TOKEN and redeploy.");
  // The production host, never the webhook URL, whose query can hold a
  // Deployment Protection bypass that mustn't reach the meeting chat.
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (!host) throw new Error("The sign-in page link needs a production deployment on Vercel.");
  const expires = String(Date.now() + TICKET_MINUTES * 60_000);
  const url = new URL(SIGN_IN_PATH, `https://${host}`);
  url.searchParams.set("ticket", `${expires}.${sign(expires, token)}`);
  return { url: url.toString(), minutes: TICKET_MINUTES };
}

/** Whether a request may open the sign-in page: the admin token, or an unexpired ticket. */
export function mayOpenSignIn(params: URLSearchParams, token: string): boolean {
  const given = params.get("token");
  if (given !== null) return same(given, token);
  const [expires = "", signature = ""] = (params.get("ticket") ?? "").split(".");
  const at = Number(expires);
  if (!Number.isFinite(at) || at < Date.now() || at > Date.now() + TICKET_MINUTES * 60_000) {
    return false;
  }
  return same(signature, sign(expires, token));
}
