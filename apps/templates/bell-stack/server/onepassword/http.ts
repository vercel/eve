import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getOnePassword, type OnePasswordOAuth } from "./oauth";
import { personalConnectionsEnabled } from "./config";

export const COOKIE = "__Secure-bell-op-browser";
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const callbackInput = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().min(1).max(4096).optional(), error: z.string().max(100).optional(), integrationKey: z.string().max(4100).optional() }).strict();
const cookie = (value: string) => `${COOKIE}=${value}; Path=/api/onepassword; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
const browserNonce = (request: Request) => request.headers.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? "";
function invalid() { return new Response("1Password could not connect. Return to Bell to reconnect or disconnect and try again.", { status: 400, headers }); }
export async function onePasswordGet(request: Request, action: string, service: () => OnePasswordOAuth = getOnePassword): Promise<Response> {
  if (action === "callback") return callbackPage();
  if (action !== "start") return new Response(null, { status: 404, headers });
  if (!personalConnectionsEnabled()) return new Response("Personal 1Password connections are not available yet.", { status: 503, headers });
  try {
    const params = new URL(request.url).searchParams;
    if (params.getAll("state").length !== 1) return invalid();
    const nonce = randomBytes(32).toString("base64url");
    return new Response(null, { status: 303, headers: { ...headers, Location: await service().open(params.get("state")!, nonce), "Set-Cookie": cookie(nonce) } });
  } catch { return invalid(); }
}
export async function onePasswordPost(request: Request, action: string, service: () => OnePasswordOAuth = getOnePassword): Promise<Response> {
  if (action !== "complete") return new Response(null, { status: 404, headers });
  try {
    const provider = service();
    if (request.headers.get("origin") !== provider.config.origin || request.headers.get("content-type")?.split(";")[0] !== "application/json") return invalid();
    const raw = await request.text();
    if (raw.length > 10_000) return invalid();
    const input = callbackInput.parse(JSON.parse(raw));
    const location = await provider.capture(input, browserNonce(request));
    return Response.json({ location }, { headers });
  } catch { return invalid(); }
}
export function callbackPage(): Response {
  const nonce = randomBytes(18).toString("base64");
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect 1Password to Bell</title><body><p id="status">Connecting your 1Password account…</p><script nonce="${nonce}">
(async () => {
  const query = new URLSearchParams(location.search), fragment = new URLSearchParams(location.hash.slice(1));
  const status = document.getElementById("status");
  try {
    if (query.getAll("state").length !== 1 || query.getAll("code").length > 1 || query.getAll("error").length > 1 || fragment.getAll("integration_key").length > 1) throw new Error();
    const body = { state: query.get("state") };
    if (query.has("code")) body.code = query.get("code");
    if (query.has("error")) body.error = query.get("error");
    if (fragment.has("integration_key")) body.integrationKey = fragment.get("integration_key");
    const response = await fetch("/api/onepassword/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    if (!response.ok) throw new Error();
    const { location: next } = await response.json();
    history.replaceState(null, "", "/api/onepassword/callback");
    const target = new URL(next);
    if (target.origin !== location.origin || !target.pathname.startsWith("/eve/v1/connections/")) throw new Error();
    location.replace(target.href);
  } catch { history.replaceState(null, "", "/api/onepassword/callback"); status.textContent = "Connection could not finish. Return to Bell to reconnect. If Bell reports a missing integration key, disconnect first."; }
})();
</script></body></html>`, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` } });
}
