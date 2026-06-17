import { InvalidArgumentError } from "#compiled/commander/index.js";

const DEVELOPMENT_SERVER_PROTOCOLS = new Set(["http:", "https:"]);

function assertDevelopmentServerProtocol(url: URL, value: string): void {
  if (!DEVELOPMENT_SERVER_PROTOCOLS.has(url.protocol)) {
    throw new InvalidArgumentError(`Expected an absolute http(s) URL, received "${value}".`);
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
