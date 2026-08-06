const MARKDOWN_ROUTE_PATTERN = /\/llms\.mdx(?:\/|$)/;

export const removeProxyMarkdownCanonical = (response: Response): Response => {
  const rewrite = response.headers.get("x-middleware-rewrite");
  if (!rewrite) return response;

  const pathname = new URL(rewrite, "https://eve.dev").pathname;
  if (MARKDOWN_ROUTE_PATTERN.test(pathname)) {
    response.headers.delete("link");
  }

  return response;
};

export const applyMarkdownRouteCanonical = (response: Response, canonicalUrl: string): Response => {
  if (response.headers.get("x-geistdocs-not-found") === "1") {
    response.headers.delete("link");
  } else {
    response.headers.set("link", `<${canonicalUrl}>; rel="canonical"`);
  }

  return response;
};
