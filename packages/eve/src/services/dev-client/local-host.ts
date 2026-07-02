const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

/** Returns whether `url` targets a recognized local development host. */
export function isLocalEveServerUrl(url: URL): boolean {
  return LOCAL_HOSTNAMES.has(url.hostname);
}

/** Whether `serverUrl` is a local dev host. Invalid URLs count as remote. */
export function isLocalDevelopmentServerUrl(serverUrl: string): boolean {
  try {
    return isLocalEveServerUrl(new URL(serverUrl));
  } catch {
    return false;
  }
}
