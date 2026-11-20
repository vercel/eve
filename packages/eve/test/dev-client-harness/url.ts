function createDevelopmentServerBaseUrl(serverUrl: string): URL {
  const url = new URL(serverUrl);

  url.hash = "";
  url.search = "";

  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }

  return url;
}

export function resolveDevelopmentServerRouteUrl(input: {
  routePath: string;
  serverUrl: string;
}): URL {
  return new URL(
    input.routePath.replace(/^\/+/, ""),
    createDevelopmentServerBaseUrl(input.serverUrl),
  );
}

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
