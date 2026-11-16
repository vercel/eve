const BROWSERBASE_HOST_SUFFIX = ".browserbase.com";

export function toEmbeddedBrowserbaseLiveViewUrl(value?: string): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    const isBrowserbaseHost =
      url.hostname === "browserbase.com" || url.hostname.endsWith(BROWSERBASE_HOST_SUFFIX);
    const isDebuggerPage = url.pathname.includes("devtools-") && url.pathname.endsWith(".html");
    const hasDebuggerSocket = url.searchParams.has("ws") || url.searchParams.has("wss");
    if (url.protocol !== "https:" || !isBrowserbaseHost || !isDebuggerPage || !hasDebuggerSocket) {
      return undefined;
    }

    url.searchParams.set("navbar", "false");
    return url.toString();
  } catch {
    return undefined;
  }
}
