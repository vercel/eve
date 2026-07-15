export const DEFAULT_DEVELOPMENT_SERVER_HOST = "127.0.0.1";

const IPV6_LOOPBACK_HOSTNAME = "[::1]";

/**
 * Hostnames Nitro/srvx surface when listening on an IPv6 wildcard interface.
 * They are valid bind targets but invalid as connect targets.
 */
const IPV6_WILDCARD_LISTEN_HOSTNAMES: ReadonlySet<string> = new Set(["[::]", "::"]);

/**
 * Rewrites a server URL whose hostname is a wildcard listen address into a
 * loopback URL on the same address family.
 */
export function normalizeDevelopmentServerClientUrl(serverUrl: string): string {
  const url = new URL(serverUrl);

  if (IPV6_WILDCARD_LISTEN_HOSTNAMES.has(url.hostname)) {
    url.hostname = IPV6_LOOPBACK_HOSTNAME;
    return url.toString();
  }

  if (url.hostname === "0.0.0.0") {
    url.hostname = DEFAULT_DEVELOPMENT_SERVER_HOST;
    return url.toString();
  }

  return serverUrl;
}
