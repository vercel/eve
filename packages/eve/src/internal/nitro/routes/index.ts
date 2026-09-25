/**
 * Public docs URL surfaced from the barebones home page. Kept in source
 * so the deployment output is a fully static, build-time-baked HTML
 * response that performs no runtime resolution.
 */
const EVE_DOCS_URL = "https://eve.dev/docs";

const AGENT_NAME_PLACEHOLDER = "{{AGENT_NAME}}";
const STATUS_DETAIL_PLACEHOLDER = "{{STATUS_DETAIL}}";
const TERMINAL_PLACEHOLDER = "{{TERMINAL}}";

const EVE_LOGO_SVG = `<svg aria-hidden="true" class="logo" fill="none" viewBox="0 0 169 53" xmlns="http://www.w3.org/2000/svg">
    <path d="M169 8.47h-51.39L81.73 53H70.36L113 0H169zM169 44.51v8.47h-45.87V44.5zM45.87 52.98H0V44.5h45.87zM38.66 30.55H0v-8.47h38.66z" fill="currentColor"></path>
    <path d="M169 30.55h-38.66v-8.47H169zM75.52 8.47H0V0h75.52z" fill="currentColor"></path>
  </svg>`;

const EVE_FAVICON_DATA_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 102 102'%3E%3Cpath fill='%23000' d='M0 0h102v102H0z'/%3E%3Cpath fill='%23fff' d='M49.28 66.94 75.03 34.96h-6.89L47.91 60.11l-5.49 6.83h6.86ZM0 34.96h42.4v5.11H0zm0 13.32h27.66v5.11H0zm0 13.54h27.66v5.11H0zm69.63-26.86H102v5.11H69.63zm4.71 13.32H102v5.11H74.34zm0 13.54H102v5.11H74.34z'/%3E%3C/svg%3E";

const COPY_ICON_SVG = `<svg aria-hidden="true" class="copy-icon" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <rect x="9" y="9" width="13" height="13" rx="2"></rect>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
  </svg>`;

const CHECK_ICON_SVG = `<svg aria-hidden="true" class="check-icon" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>`;

/**
 * Inline copy-button behavior. Reads the command straight from the rendered
 * `.terminal-cmd` node so we never re-serialize (and thus never risk
 * double-escaping) the value into a script string. It touches no request
 * state and loads nothing external, so it cannot leak the deployment origin.
 */
const COPY_SCRIPT = `<script>
(function () {
  var button = document.querySelector(".terminal-copy");
  var command = document.querySelector(".terminal-cmd");
  if (!button || !command || !navigator.clipboard) {
    if (button) button.hidden = true;
    return;
  }
  var reset;
  button.addEventListener("click", function () {
    navigator.clipboard.writeText(command.textContent || "").then(function () {
      button.classList.add("copied");
      button.setAttribute("aria-label", "Copied");
      clearTimeout(reset);
      reset = setTimeout(function () {
        button.classList.remove("copied");
        button.setAttribute("aria-label", "Copy command");
      }, 1500);
    });
  });
})();
</script>`;

/**
 * Barebones HTML served at `GET /`.
 *
 * Reveals only the deployed agent's display name — no model, no instructions,
 * no list of skills or schedules, no API endpoint paths. Inspection JSON
 * (model id, instructions, tools, skills, etc.) lives behind the resolved eve
 * channel auth policy at `/eve/v1/info`.
 *
 * The page loads zero external assets — no fonts, no images, no
 * analytics beacons, and no external scripts — so it cannot leak the
 * deployment's origin to a third party simply by being visited. The only
 * script is an inline copy-button handler that reads local DOM state.
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
<link rel="icon" href="${EVE_FAVICON_DATA_URL}" type="image/svg+xml">
<title>eve</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fff;
    --fg: #0a0a0a;
    --muted: #6b6b6b;
    --faint: #999;
    --border: rgba(0, 0, 0, 0.09);
    --accent: #00c46a;
    --divider: rgba(0, 0, 0, 0.22);
    --brand-opacity: 0.08;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a0a0a;
      --fg: #f5f5f5;
      --muted: #a3a3a3;
      --faint: #737373;
      --border: rgba(255, 255, 255, 0.14);
      --accent: #46d4a4;
      --divider: rgba(255, 255, 255, 0.22);
      --brand-opacity: 0.12;
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
    max-width: 28rem;
    text-align: left;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 1.5rem;
  }
  .brand {
    margin: 0;
    display: flex;
    justify-content: flex-start;
    color: var(--fg);
    opacity: var(--brand-opacity);
  }
  .logo {
    display: block;
    width: 4.875rem;
    height: auto;
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }
  .agent-row {
    display: flex;
    align-items: center;
    gap: 0.9375rem;
    min-width: 0;
  }
  .agent-name {
    color: var(--fg);
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.55;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: inherit;
    line-height: inherit;
    color: var(--accent);
    margin: 0;
  }
  .status-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
  }
  .lede-divider {
    color: var(--divider);
  }
  .lede {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    color: var(--muted);
    font-size: 0.875rem;
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
    padding: 0.8125rem 1.0625rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    text-align: left;
    font-size: 0.8125rem;
    margin: 1rem 0 0;
    overflow: hidden;
    white-space: nowrap;
  }
  .terminal-prompt {
    color: var(--faint);
    user-select: none;
    flex-shrink: 0;
  }
  .terminal-cmd {
    color: var(--fg);
    flex: 1 1 auto;
    min-width: 0;
    overflow-x: auto;
    /* Keep the command horizontally scrollable but hide the scrollbar chrome. */
    scrollbar-width: none;
  }
  .terminal-cmd::-webkit-scrollbar { display: none; }
  .terminal-copy {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 1.75rem;
    height: 1.75rem;
    margin: -0.375rem -0.4375rem -0.375rem 0;
    padding: 0;
    border: 0;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--faint);
    cursor: pointer;
    transition: color 0.15s ease, background 0.15s ease;
  }
  .terminal-copy:hover {
    color: var(--fg);
    background: var(--border);
  }
  .terminal-copy:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .terminal-copy svg {
    display: block;
    width: 0.875rem;
    height: 0.875rem;
  }
  .terminal-copy .check-icon { display: none; }
  .terminal-copy.copied { color: var(--accent); }
  .terminal-copy.copied .copy-icon { display: none; }
  .terminal-copy.copied .check-icon { display: block; }
</style>
</head>
<body>
<main>
  <div class="brand" aria-label="eve">${EVE_LOGO_SVG}</div>
  <section class="panel" aria-label="Agent status">
    <div class="agent-row">
      <strong class="agent-name">${AGENT_NAME_PLACEHOLDER}</strong>
    </div>
    <p class="lede"><span class="status"><span class="status-dot" aria-hidden="true"></span>Ready</span><span class="lede-divider" aria-hidden="true">／</span><span>${STATUS_DETAIL_PLACEHOLDER}</span> <a href="${EVE_DOCS_URL}">Docs<span class="lede-arrow" aria-hidden="true">&nbsp;&rarr;</span></a></p>
    ${TERMINAL_PLACEHOLDER}
  </section>
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

/** Render the shared lightweight deployment status page. */
export function buildHomePageHtml(input: {
  readonly name: string;
  readonly statusDetail: string;
  readonly terminalCommand?: string;
}): string {
  const terminal =
    input.terminalCommand === undefined
      ? ""
      : `<div class="terminal mono" role="group" aria-label="Send a message from your terminal">
      <span class="terminal-prompt" aria-hidden="true">$</span>
      <span class="terminal-cmd">${escapeHtml(input.terminalCommand)}</span>
      <button type="button" class="terminal-copy" aria-label="Copy command">${COPY_ICON_SVG}${CHECK_ICON_SVG}</button>
    </div>
    ${COPY_SCRIPT}`;

  return HOME_PAGE_HTML_TEMPLATE.replace(AGENT_NAME_PLACEHOLDER, () => escapeHtml(input.name))
    .replace(STATUS_DETAIL_PLACEHOLDER, () => escapeHtml(input.statusDetail))
    .replace(TERMINAL_PLACEHOLDER, () => terminal);
}

/**
 * Builds the barebones home page response for one request. Exposed
 * for tests so callers can supply a real {@link Request}; production
 * traffic flows through the Nitro {@link H3Event} default export.
 */
export function buildHomePageResponse(
  input: {
    readonly agentName: string;
  },
  request: Request,
): Response {
  const deploymentUrl = resolveDeploymentUrl(request);
  const html = buildHomePageHtml({
    name: input.agentName,
    statusDetail: "Agent is up and accepting messages.",
    terminalCommand: `eve remote connect ${deploymentUrl}`,
  });

  return new Response(html, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    },
  });
}
