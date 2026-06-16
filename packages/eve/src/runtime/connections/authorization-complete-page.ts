/**
 * Renders the static HTML landing page that the user's browser sees
 * after an OAuth IdP redirects back to the framework's connection
 * callback route.
 *
 * The framework would otherwise respond with an empty `202 Accepted`
 * body, which looks broken. This helper is intentionally self-contained:
 * no external assets, no script, so it renders identically regardless
 * of where the runtime serves the callback from.
 */
export function buildAuthorizationCompletePage(): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Authorization complete</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #fafafa;
        --fg: #111111;
        --muted: #525252;
        --card-bg: #ffffff;
        --card-border: #e5e5e5;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0a0a0a;
          --fg: #fafafa;
          --muted: #a3a3a3;
          --card-bg: #171717;
          --card-border: #262626;
        }
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        background: var(--bg);
        color: var(--fg);
      }
      .card {
        max-width: 28rem;
        padding: 2rem 2.25rem;
        border: 1px solid var(--card-border);
        border-radius: 12px;
        background: var(--card-bg);
        color: var(--fg);
        text-align: center;
      }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; color: var(--fg); }
      p { margin: 0; color: var(--muted); line-height: 1.5; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Authorization complete</h1>
      <p>You can close this tab and return to your app.</p>
    </main>
  </body>
</html>`;
  return new Response(html, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    },
    status: 200,
  });
}
