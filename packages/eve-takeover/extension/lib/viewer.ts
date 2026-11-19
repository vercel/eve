import { randomBytes, timingSafeEqual } from "node:crypto";
import { routeAuth } from "eve/channels/auth";
import {
  mintStreamToken,
  openTakeoverGrant,
  type TakeoverGrant,
  type TakeoverRequester,
} from "./keys.ts";
import { TAKEOVER_ROUTE_PREFIX, type Takeover, type TakeoverViewer } from "./takeover.ts";
import { TAKEOVER_DONE_PARAM } from "./tool.ts";
import { VIEWER_CLIENT_SOURCE } from "./viewer-client.ts";

/** Lifetime of the stream token the page connects with; it is used once, right away. */
export const PAGE_STREAM_TOKEN_TTL_MS = 60_000;

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" } as const;

/** Default: the viewer signed in the same way, as the same principal. */
export function sameRequester(viewer: TakeoverViewer, requester: TakeoverRequester): boolean {
  return (
    viewer.principalType === "user" &&
    viewer.authenticator === requester.authenticator &&
    (viewer.issuer ?? "") === (requester.issuer ?? "") &&
    equal(viewer.principalId, requester.principalId)
  );
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

type Authorized =
  | { readonly ok: true; readonly grant: TakeoverGrant }
  | {
      readonly ok: false;
      readonly status: number;
      readonly reason: string;
      readonly signIn?: boolean;
    };

async function authorize(
  takeover: Takeover,
  request: Request,
  sealed: string,
): Promise<Authorized> {
  const opened = openTakeoverGrant(takeover.keys, sealed);
  if (opened.status === "invalid")
    return { ok: false, status: 400, reason: "This takeover link is not valid." };
  if (opened.status !== "ok")
    return { ok: false, status: 410, reason: "This takeover link has expired." };
  const result = await routeAuth(request, takeover.options.auth);
  if (result instanceof Response) {
    return {
      ok: false,
      status: result.status === 403 ? 403 : 401,
      reason: "Sign in to open this takeover.",
      signIn: result.status !== 403,
    };
  }
  const viewer: TakeoverViewer = result;
  const isRequester = takeover.options.isRequester ?? sameRequester;
  if (!(await isRequester(viewer, opened.grant.requester))) {
    return {
      ok: false,
      status: 403,
      reason: "Only the person who asked the agent to hand over control can open this.",
    };
  }
  return { ok: true, grant: opened.grant };
}

/** POSTs from the page must come from the agent's own origin: the session is a cookie. */
function sameOrigin(takeover: Takeover, request: Request): boolean {
  const base = takeover.baseUrl();
  const origin = request.headers.get("origin");
  return base !== null && origin !== null && origin === new URL(base).origin;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** `GET /takeover/:grant`: the viewer page. */
export async function viewerPage(
  takeover: Takeover,
  request: Request,
  sealed: string,
): Promise<Response> {
  const access = await authorize(takeover, request, sealed);
  if (!access.ok) {
    if (access.signIn && takeover.options.signInUrl) {
      const target = takeover.options.signInUrl(`${TAKEOVER_ROUTE_PREFIX}/${sealed}`);
      return new Response(null, { status: 302, headers: { ...NO_STORE, location: target } });
    }
    return messagePage(access.status, access.reason);
  }
  const { grant } = access;
  const nonce = randomBytes(16).toString("base64");
  const data = {
    stream: grant.stream,
    protocol: grant.protocol,
    label: grant.label,
    expiresAt: grant.exp,
    tokenPath: `${TAKEOVER_ROUTE_PREFIX}/${sealed}/token`,
    // eve's sign-in callback: opening it completes the takeover's sign-in and resumes the turn.
    doneUrl: callbackWith(grant.callback, TAKEOVER_DONE_PARAM, "done"),
    cancelUrl: callbackWith(grant.callback, "error", "access_denied"),
  };
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src data:",
    `connect-src 'self' ${new URL(grant.stream).origin}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return new Response(pageHtml(nonce, grant, data), {
    headers: {
      ...NO_STORE,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "x-content-type-options": "nosniff",
    },
  });
}

/** `POST /takeover/:grant/token`: a one-use stream token for the requester. */
export async function viewerToken(
  takeover: Takeover,
  request: Request,
  sealed: string,
): Promise<Response> {
  if (!sameOrigin(takeover, request)) return json({ error: "Cross-origin request." }, 403);
  const access = await authorize(takeover, request, sealed);
  if (!access.ok) return json({ error: access.reason }, access.status);
  const { token, expiresAt } = mintStreamToken(takeover.keys, {
    sessionId: access.grant.sid,
    callId: access.grant.cid,
    ttlMs: PAGE_STREAM_TOKEN_TTL_MS,
  });
  return json({ token, expiresAt });
}

function callbackWith(callback: string, key: string, value: string): string {
  const url = new URL(callback);
  url.searchParams.set(key, value);
  return url.toString();
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `
:root { color-scheme: light dark; --bg: #fff; --fg: #111; --muted: #666; --border: #e5e5e5; --surface: #fafafa; --warn: #a35200; }
@media (prefers-color-scheme: dark) { :root { --bg: #0a0a0a; --fg: #ededed; --muted: #a1a1a1; --border: #2e2e2e; --surface: #111; --warn: #ffb224; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 32px 20px; }
header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
h1 { font-size: 20px; margin: 0; }
p { margin: 4px 0 0; color: var(--muted); }
.status { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); white-space: nowrap; }
.status[data-tone="live"] { color: #0a7a3b; border-color: #0a7a3b55; }
.status[data-tone="pending"] { color: var(--warn); }
.warn { margin-top: 16px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); font-size: 13px; }
.frame { margin-top: 12px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.bar { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--muted); }
.bar code { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
canvas { display: block; width: 100%; aspect-ratio: 16 / 9; background: var(--surface); outline: none; }
canvas:focus-visible { box-shadow: inset 0 0 0 2px var(--fg); }
.actions { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); cursor: pointer; }
button.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
button:disabled { opacity: 0.5; cursor: default; }
.notice { margin: 0; font-size: 13px; color: var(--muted); }
`;

function pageHtml(nonce: string, grant: TakeoverGrant, data: Record<string, unknown>): string {
  const label = escapeHtml(grant.label);
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Take over the ${label}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>${escapeHtml(grant.task)}</h1>
      <p>Do this step in the live ${label} below, then press Done to hand control back.</p>
    </div>
    <span class="status" id="status" data-tone="pending">Connecting</span>
  </header>
  <div class="warn">Only you can open this page. What you type goes straight to the ${label} and isn't recorded, but after you hand it back, the agent can see what you left on screen. Prefer a test or least-privileged account.</div>
  <div class="frame">
    <div class="bar"><code id="url">${label}</code><span id="time"></span></div>
    <canvas id="screen" tabindex="0" role="application" aria-label="Live ${label}. Click to focus, then type."></canvas>
  </div>
  <div class="actions">
    <button class="primary" id="done" type="button">Done</button>
    <button id="cancel" type="button">Cancel</button>
    <button id="reconnect" type="button" hidden>Reconnect</button>
    <p class="notice" id="notice" hidden></p>
  </div>
</main>
<script type="application/json" id="takeover-data">${payload}</script>
<script nonce="${nonce}">${VIEWER_CLIENT_SOURCE}</script>
</body>
</html>`;
}

function messagePage(status: number, message: string): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Takeover</title></head><body style="font:14px system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 20px"><p>${escapeHtml(message)}</p></body></html>`;
  return new Response(body, {
    status,
    headers: {
      ...NO_STORE,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}
