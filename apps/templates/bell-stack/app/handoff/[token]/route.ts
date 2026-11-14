import { BrowserHandoffError, verifyBrowserHandoffToken } from "../../../server/browser/handoff";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  try {
    verifyBrowserHandoffToken(token);
  } catch (error) {
    return handoffError(error);
  }

  const livePath = `/handoff/${encodeURIComponent(token)}/live`;
  return new Response(handoffPage(livePath), {
    headers: handoffHeaders("text/html; charset=utf-8"),
  });
}

function handoffPage(livePath: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
    <title>Bell human handoff</title>
    <style>
      * { box-sizing: border-box; }
      html, body { height: 100%; margin: 0; }
      body { background: #f7f7f5; color: #181817; font: 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { display: grid; grid-template-rows: auto minmax(0, 1fr); height: 100%; padding: 12px; gap: 10px; }
      header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
      h1 { font-size: 16px; margin: 0; }
      p { color: #64635f; margin: 0; }
      iframe { background: white; border: 1px solid #deddd8; border-radius: 12px; height: 100%; width: 100%; }
    </style>
  </head>
  <body>
    <main>
      <header><h1>Bell needs your help</h1><p>Complete the step, then return to your Bell conversation.</p></header>
      <iframe src="${livePath}" title="Bell live browser" allow="clipboard-read; clipboard-write"></iframe>
    </main>
  </body>
</html>`;
}

function handoffError(error: unknown): Response {
  const status =
    error instanceof BrowserHandoffError && error.code === "expired"
      ? 410
      : error instanceof BrowserHandoffError && error.code === "configuration"
        ? 503
        : 404;
  const message =
    status === 410 ? "This handoff link expired." : "This handoff link is not available.";
  return new Response(message, {
    status,
    headers: handoffHeaders("text/plain; charset=utf-8"),
  });
}

function handoffHeaders(contentType: string): HeadersInit {
  return {
    "cache-control": "no-store, private, max-age=0",
    "content-security-policy":
      "default-src 'none'; frame-src 'self' https://browserbase.com https://*.browserbase.com; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}
