import { resolveInstalledPackageInfo } from "#internal/application/package.js";

/** Product token for the installed package, such as `package-name/1.2.3`. */
export function buildPackageUserAgent(): string {
  const { name, version } = resolveInstalledPackageInfo();
  return `${name}/${version}`;
}

/**
 * Joins User-Agent product tokens with spaces per the RFC 9110 `User-Agent`
 * grammar (`product *( RWS ( product / comment ) )`), skipping empty parts.
 * Never join UA products with `Headers.append()` — repeated header values
 * combine with `", "`, and a comma glued to a product token breaks
 * whitespace-delimited parsers on the receiving side.
 */
function joinUserAgentProducts(...products: (string | null | undefined)[]): string {
  return products.filter(Boolean).join(" ");
}

/** Appends the installed package product without discarding an existing User-Agent. */
export function appendPackageUserAgent(headers: Headers): Headers {
  const product = buildPackageUserAgent();
  const existing = headers.get("user-agent");
  if (existing?.split(/\s+/).includes(product)) return headers;
  headers.set("user-agent", joinUserAgentProducts(existing, product));
  return headers;
}
