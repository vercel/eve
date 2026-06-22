import type { H3Event } from "nitro";

/**
 * Public docs URL surfaced from the barebones home page. Kept in source
 * so the deployment output is a fully static, build-time-baked HTML
 * response that performs no runtime resolution.
 */
const EVE_DOCS_URL = "https://eve.dev/docs";

const DEPLOYMENT_URL_PLACEHOLDER = "{{DEPLOYMENT_URL}}";

/**
 * Barebones HTML served at `GET /`.
 *
 * Reveals no information about the deployed agent — no name, no model,
 * no instructions, no list of skills or schedules, no API endpoint paths.
 * This is intentional: the root URL of a deployment is reachable by
 * anyone on the public internet, and the deployment must not advertise
 * its agent's configuration to unauthenticated callers. Inspection JSON
 * (model id, instructions, tools, skills, etc.) lives behind the default
 * local-dev / Vercel OIDC auth chain at `/eve/v1/info`.
 *
 * The page also loads zero external assets — no fonts, no scripts, no
 * images, no analytics beacons — so it cannot leak the deployment's
 * origin to a third party simply by being visited.
 *
 * `{{DEPLOYMENT_URL}}` is the only request-time substitution: the page
 * echoes the visitor's own request origin back into the `$ eve dev …`
 * hint so they can copy-paste it without typing the URL by hand. We
 * don't read any other request state.
 */
const HOME_PAGE_HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>eve</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fff;
    --fg: #0a0a0a;
    --muted: #6b6b6b;
    --faint: #999;
    --border: rgba(0, 0, 0, 0.09);
    --surface: rgba(0, 0, 0, 0.025);
    --accent: #00c46a;
    --accent-glow: rgba(0, 196, 106, 0.18);
    --button-bg: #0a0a0a;
    --button-fg: #fff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #000;
      --fg: #ededed;
      --muted: #8f8f8f;
      --faint: #666;
      --border: rgba(255, 255, 255, 0.1);
      --surface: rgba(255, 255, 255, 0.035);
      --accent: #46d4a4;
      --accent-glow: rgba(70, 212, 164, 0.22);
      --button-bg: #fff;
      --button-fg: #000;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI",
      Roboto, "Helvetica Neue", Arial, sans-serif;
    font-feature-settings: "cv11", "ss01";
    font-size: 15px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
    display: grid;
    place-items: center;
    padding: 2rem;
  }
  .mono {
    font-family: ui-monospace, "SF Mono", "Menlo", "JetBrains Mono",
      "Cascadia Code", Consolas, "Liberation Mono", monospace;
    font-feature-settings: "zero", "ss01";
  }
  main {
    width: 100%;
    max-width: 32rem;
    text-align: center;
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3125rem 0.75rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 9999px;
    font-size: 0.75rem;
    color: var(--muted);
    margin: 0 0 2rem;
  }
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
    flex-shrink: 0;
  }
  h1 {
    margin: 0 0 0.875rem;
    font-size: clamp(2.5rem, 9vw, 3.25rem);
    font-weight: 500;
    letter-spacing: -0.05em;
    line-height: 1;
  }
  .lede {
    margin: 0 0 1.5rem;
    color: var(--muted);
    font-size: 0.9375rem;
  }
  .lede a {
    color: var(--fg);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
    text-decoration-color: var(--border);
    transition: text-decoration-color 0.15s ease;
    white-space: nowrap;
  }
  .lede a:hover { text-decoration-color: var(--fg); }
  .lede-arrow {
    display: inline-block;
    margin-left: 0.125rem;
    transition: transform 0.15s ease;
  }
  .lede a:hover .lede-arrow { transform: translateX(2px); }
  .terminal {
    display: inline-flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    max-width: 28rem;
    padding: 0.75rem 1rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    text-align: left;
    font-size: 0.8125rem;
    margin: 0 auto;
    overflow-x: auto;
    white-space: nowrap;
  }
  .terminal-prompt {
    color: var(--faint);
    user-select: none;
    flex-shrink: 0;
  }
  .terminal-cmd { color: var(--fg); }
</style>
</head>
<body>
<main>
  <span class="status mono">
    <span class="status-dot" aria-hidden="true"></span>
    running
  </span>
  <h1 class="mono">eve</h1>
  <p class="lede">The agent is up and accepting messages. <a href="${EVE_DOCS_URL}">Read the docs<span class="lede-arrow" aria-hidden="true">&nbsp;&rarr;</span></a></p>
  <div class="terminal mono" role="group" aria-label="Send a message from your terminal">
    <span class="terminal-prompt" aria-hidden="true">$</span>
    <span class="terminal-cmd">eve dev ${DEPLOYMENT_URL_PLACEHOLDER}</span>
  </div>
</main>
</body>
</html>
`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pickFirstForwardedValue(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }
  const first = value.split(",")[0]?.trim();
  if (first === undefined || first.length === 0) {
    return undefined;
  }
  return first;
}

/**
 * Resolves the public origin a visitor is using to reach the deployment.
 *
 * Prefers the `x-forwarded-host` / `x-forwarded-proto` headers set by
 * Vercel's edge so the rendered URL matches the address the visitor
 * actually typed (including custom domains), then falls back to the
 * `host` header, then to `request.url` for local `eve dev` runs that
 * skip the proxy chain. Comma-separated forwarded values are split and
 * the first hop is used — that is the public-facing entry, the rest are
 * internal forwarder hostnames.
 */
function resolveDeploymentUrl(request: Request): string {
  const headers = request.headers;
  const requestUrl = new URL(request.url);
  const forwardedHost = pickFirstForwardedValue(headers.get("x-forwarded-host"));
  const forwardedProto = pickFirstForwardedValue(headers.get("x-forwarded-proto"));
  const host = forwardedHost ?? headers.get("host") ?? requestUrl.host;
  const proto = forwardedProto ?? requestUrl.protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}

/**
 * Builds the barebones home page response for one request. Exposed
 * for tests so callers can supply a real {@link Request}; production
 * traffic flows through the Nitro {@link H3Event} default export.
 */
export function buildHomePageResponse(request: Request): Response {
  const deploymentUrl = resolveDeploymentUrl(request);
  const html = HOME_PAGE_HTML_TEMPLATE.replace(
    DEPLOYMENT_URL_PLACEHOLDER,
    escapeHtml(deploymentUrl),
  );

  return new Response(html, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Nitro route handler for `GET /`. Adapts the Nitro event shape into
 * {@link buildHomePageResponse}.
 */
export default function handleHomePageRequest(event: H3Event): Response {
  return buildHomePageResponse(event.req);
}
