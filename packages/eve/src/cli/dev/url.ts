import { InvalidArgumentError } from "#compiled/commander/index.js";
import { isLocalEveServerUrl } from "#services/dev-client/local-host.js";

const DEVELOPMENT_SERVER_PROTOCOLS = new Set(["http:", "https:"]);

function assertDevelopmentServerProtocol(url: URL, value: string): void {
  if (!DEVELOPMENT_SERVER_PROTOCOLS.has(url.protocol)) {
    throw new InvalidArgumentError(`Expected an absolute http(s) URL, received "${value}".`);
  }
}

/**
 * Rejects insecure remote targets. A remote Vercel deployment is always served
 * over https, and the verified-remote client only emits ambient credentials to
 * a matching https origin — an `http://` remote would fail that origin check.
 * Loopback hosts may keep using `http://` for local development servers.
 */
function assertSecureRemoteProtocol(url: URL, value: string): void {
  if (url.protocol === "http:" && !isLocalEveServerUrl(url)) {
    throw new InvalidArgumentError(
      `Remote servers must use https://; received "${value}". Only local hosts may use http://.`,
    );
  }
}

/**
 * Parse and normalize an eve server URL for the development REPL.
 */
export function parseDevelopmentServerUrl(value: string): string {
  const normalizedValue = value.trim();

  try {
    const url = new URL(normalizedValue);

    assertDevelopmentServerProtocol(url, value);
    assertSecureRemoteProtocol(url, value);
    url.hash = "";
    url.search = "";

    return url.toString();
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      throw error;
    }

    throw new InvalidArgumentError(`Expected an absolute http(s) URL, received "${value}".`);
  }
}
