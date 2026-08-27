import { InvalidArgumentError } from "#compiled/commander/index.js";
import { isLocalEveServerUrl } from "#services/dev-client/local-host.js";

const DEVELOPMENT_SERVER_PROTOCOLS = new Set(["http:", "https:"]);

function assertDevelopmentServerProtocol(url: URL, value: string): void {
  if (!DEVELOPMENT_SERVER_PROTOCOLS.has(url.protocol)) {
    throw new InvalidArgumentError(`Expected an absolute http(s) URL, received "${value}".`);
  }
}

/**
 * Reject http for remote hosts. The verified-remote client only sends
 * credentials to an https origin, so an http remote would never authenticate.
 * Loopback stays http for local dev.
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

    return url.toString();
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      throw error;
    }

    throw new InvalidArgumentError(`Expected an absolute http(s) URL, received "${value}".`);
  }
}
