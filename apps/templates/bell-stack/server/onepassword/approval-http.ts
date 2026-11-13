import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getOnePasswordLogin, type OnePasswordLogin } from "./login";
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const input = z.object({ cap: z.string().regex(/^[A-Za-z0-9_-]{43}$/), manual: z.boolean().optional() }).strict();
export async function approvalPost(request: Request, action: string, service: () => OnePasswordLogin = getOnePasswordLogin) {
  try {
    const login = service();
    if (request.headers.get("origin") !== login.oauth.config.origin || request.headers.get("content-type")?.split(";")[0] !== "application/json") throw new Error();
    const raw = await request.text();
    if (raw.length > 512) throw new Error();
    const parsed = input.parse(JSON.parse(raw));
    const result = action === "approval-open" ? await login.opened(parsed.cap) : await login.poll(parsed.cap, parsed.manual ?? false);
    return Response.json(result, { headers });
  } catch { return Response.json({ error: "Approval could not continue. Return to Bell and start a new login request." }, { status: 400, headers }); }
}
export function approvalPage(): Response {
  const nonce = randomBytes(18).toString("base64");
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Approve a Bell login</title><body><h1>Approve a Bell login</h1><p>Use the computer running your 1Password desktop app. Check the requested website before approving.</p><button id="open">Open 1Password</button><button id="check" hidden>I approved — check again</button><p id="status"></p><script nonce="${nonce}">
(() => {
  const cap = location.hash.slice(1), status = document.getElementById("status"), open = document.getElementById("open"), check = document.getElementById("check");
  history.replaceState(null, "", "/api/onepassword/approval");
  let polling = false;
  async function post(action, manual = false) {
    const response = await fetch("/api/onepassword/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cap, manual }), credentials: "same-origin" });
    if (!response.ok) throw new Error();
    return response.json();
  }
  async function poll(manual = false) {
    if (polling) return;
    polling = true;
    check.hidden = true;
    try {
      const result = await post("approval-poll", manual);
      if (result.location) {
        const target = new URL(result.location);
        if (target.origin !== location.origin || !target.pathname.startsWith("/eve/v1/connections/")) throw new Error();
        location.replace(target.href);
        return;
      }
      if (result.status === "pending") { status.textContent = "Waiting for approval in 1Password…"; setTimeout(() => poll(), (result.retryAfter || 5) * 1000); }
      else if (result.status === "waiting_for_user") { status.textContent = "Automatic checks have stopped. Check once more after approving."; check.hidden = false; }
      else status.textContent = "The login was not approved. Return to Bell.";
    } catch { status.textContent = "Could not continue this approval. Return to Bell and start a new login request."; }
    finally { polling = false; }
  }
  open.onclick = async () => {
    const popup = window.open("about:blank", "_blank");
    if (!popup) { status.textContent = "Allow this page to open the 1Password approval window, then try again."; return; }
    popup.opener = null;
    open.disabled = true;
    try { const result = await post("approval-open"); popup.location.href = result.appLink; status.textContent = "Approve the login for " + result.website; setTimeout(() => poll(), 5000); }
    catch { popup.close(); status.textContent = "This approval expired. Return to Bell."; }
  };
  check.onclick = () => poll(true);
})();
</script></body></html>`, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` } });
}
