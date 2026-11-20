const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

export function isLocalEveServerUrl(url: URL): boolean {
  return LOCAL_HOSTNAMES.has(url.hostname);
}

export function isLocalDevelopmentServerUrl(serverUrl: string): boolean {
  try {
    return isLocalEveServerUrl(new URL(serverUrl));
  } catch {
    return false;
  }
}
