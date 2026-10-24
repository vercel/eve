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
export function buildAuthorizationCallbackPage(): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign-in response received</title>
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
          <h1 id="authorization-title">Sign-in response received</h1>
          <div class="icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="7.25" stroke="currentColor" stroke-width="1.5" />
              <path d="M8 7v4" stroke="currentColor" stroke-width="1.5" />
              <circle cx="8" cy="4.5" r="0.75" fill="currentColor" />
            </svg>
          </div>
        </div>
        <div style="height: 0.5rem" aria-hidden="true"></div>
        <p>Return to your app to check whether sign-in succeeded. You can close this tab.</p>
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
