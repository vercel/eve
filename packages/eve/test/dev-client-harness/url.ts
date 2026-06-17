function createDevelopmentServerBaseUrl(serverUrl: string): URL {
  const url = new URL(serverUrl);

  url.hash = "";
  url.search = "";

  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }

  return url;
}

/**
 * Resolves one eve route against the configured development server URL.
 *
 * Test-only helper.
 */
export function resolveDevelopmentServerRouteUrl(input: {
  routePath: string;
  serverUrl: string;
}): URL {
  return new URL(
    input.routePath.replace(/^\/+/, ""),
    createDevelopmentServerBaseUrl(input.serverUrl),
  );
}

/**
 * Resolves one server-provided resource reference against the configured
 * development server URL. Absolute resource URLs are returned untouched;
 * relative routes are resolved against the development server base.
 *
 * Test-only helper.
 */
export function resolveDevelopmentServerResourceUrl(input: {
  resource: string;
  serverUrl: string;
}): URL {
  const resource = input.resource.trim();

  try {
    return new URL(resource);
  } catch {
    return new URL(resource.replace(/^\/+/, ""), createDevelopmentServerBaseUrl(input.serverUrl));
  }
}
