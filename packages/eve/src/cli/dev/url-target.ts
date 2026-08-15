import { InvalidArgumentError } from "#compiled/commander/index.js";
import { encodeBasicCredentials } from "#internal/http/basic-auth.js";

export type DevelopmentRequestHeaders = Readonly<Record<string, string>>;

export interface DevelopmentUrlTargetOptions {
  header?: DevelopmentRequestHeaders;
  host?: string;
  port?: number;
  ui?: boolean;
  url?: string;
}

export interface DevelopmentUrlTarget {
  readonly headers?: DevelopmentRequestHeaders;
  readonly serverUrl: string;
}

export function parseDevelopmentHeaderOption(
  value: string,
  previous: DevelopmentRequestHeaders = {},
): DevelopmentRequestHeaders {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex < 1) {
    throw new InvalidArgumentError(`Expected header in "Name: value" format, received "${value}".`);
  }

  const name = value.slice(0, separatorIndex).trim();
  const headerValue = value.slice(separatorIndex + 1).trim();
  try {
    new Headers([[name, headerValue]]);
  } catch {
    throw new InvalidArgumentError(`Expected a valid HTTP header, received "${value}".`);
  }
  return mergeDevelopmentHeaders(previous, { [name]: headerValue }) ?? {};
}

export function resolveDevelopmentUrlTarget(
  options: DevelopmentUrlTargetOptions,
  positionalUrl: string | undefined,
): DevelopmentUrlTarget | undefined {
  if (options.url !== undefined && positionalUrl !== undefined) {
    throw new InvalidArgumentError("Pass either --url or a bare URL, not both.");
  }

  const url = options.url ?? positionalUrl;
  if (url === undefined) {
    if (options.header !== undefined) {
      throw new InvalidArgumentError(
        "The --header option can only be used with --url or a bare URL.",
      );
    }
    return undefined;
  }

  if (options.host !== undefined) {
    throw new InvalidArgumentError("The --host option cannot be used with --url.");
  }
  if (options.port !== undefined) {
    throw new InvalidArgumentError("The --port option cannot be used with --url.");
  }
  if (options.ui === false) {
    throw new InvalidArgumentError("The --no-ui option cannot be used with --url.");
  }

  const parsedUrl = URL.parse(url);
  if (parsedUrl === null) {
    throw new InvalidArgumentError(`Expected an absolute http(s) URL, received "${url}".`);
  }

  const headers = mergeDevelopmentHeaders(extractDevelopmentUrlHeaders(parsedUrl), options.header);
  const serverUrl = parsedUrl.toString();
  return headers === undefined ? { serverUrl } : { headers, serverUrl };
}

function mergeDevelopmentHeaders(
  base: DevelopmentRequestHeaders | undefined,
  override: DevelopmentRequestHeaders | undefined,
): DevelopmentRequestHeaders | undefined {
  if (base === undefined) return override;
  if (override === undefined) return base;

  const headers: Record<string, string> = {};
  const overrideNames = new Set(Object.keys(override).map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(base)) {
    if (!overrideNames.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }
  for (const [name, value] of Object.entries(override)) {
    headers[name] = value;
  }
  return headers;
}

function extractDevelopmentUrlHeaders(url: URL): DevelopmentRequestHeaders | undefined {
  if (url.username === "" && url.password === "") return undefined;

  const username = decodeUrlUserInfo(url.username, "username");
  const password = decodeUrlUserInfo(url.password, "password");
  url.username = "";
  url.password = "";
  return {
    Authorization: `Basic ${encodeBasicCredentials(username, password)}`,
  };
}

function decodeUrlUserInfo(value: string, label: "username" | "password"): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new InvalidArgumentError(`Expected a valid URL-encoded ${label} in URL userinfo.`);
  }
}
