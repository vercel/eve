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
        --background: oklch(0.984 0 0);
        --foreground: oklch(0.205 0 0);
        --secondary: oklch(0.42 0 0);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --background: oklch(0.027 0 0);
          --foreground: oklch(0.946 0 0);
          --secondary: oklch(0.706 0 0);
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Geist Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
        -webkit-font-smoothing: antialiased;
        background: var(--background);
        color: var(--foreground);
      }
      .screen {
        min-height: 100vh;
        min-height: 100dvh;
        padding: 2rem 1rem;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--background);
        color: var(--foreground);
      }
      .content {
        width: 100%;
        max-width: 27.5rem;
      }
      .header {
        padding: 1.5rem 1.5rem 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
      }
      .icon {
        width: 2rem;
        height: 2rem;
        margin-top: 1.5rem;
        color: var(--foreground);
      }
      .icon svg {
        display: block;
        width: 100%;
        height: 100%;
      }
      h1 {
        margin: 1.5rem 0 0;
        color: var(--foreground);
        font-size: 1.5rem;
        font-weight: 600;
        line-height: 2rem;
        letter-spacing: -0.06rem;
      }
      p {
        margin: 0;
        padding: 1rem 1.5rem;
        color: var(--secondary);
        font-size: 0.8125rem;
        line-height: 1.125rem;
        text-align: center;
      }
    </style>
  </head>
  <body>
    <main class="screen" aria-labelledby="authorization-title">
      <div class="content">
        <div class="header">
          <h1 id="authorization-title">Authorization complete</h1>
          <div class="icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none">
              <path fill="currentColor" fill-rule="evenodd" d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0m-4.47-1.47.53-.53L11 4.94l-.53.53L6.5 9.44l-.97-.97L5 7.94 3.94 9l.53.53 1.5 1.5c.3.3.77.3 1.06 0z" clip-rule="evenodd" />
            </svg>
          </div>
        </div>
        <div style="height: 0.5rem" aria-hidden="true"></div>
        <p>You can close this tab and return to your app.</p>
      </div>
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
