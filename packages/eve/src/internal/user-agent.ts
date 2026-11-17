import { resolveInstalledPackageInfo } from "#internal/application/package.js";

export function buildPackageUserAgent(): string {
  const { name, version } = resolveInstalledPackageInfo();
  return `${name}/${version}`;
}

function joinUserAgentProducts(...products: (string | null | undefined)[]): string {
  return products.filter(Boolean).join(" ");
}

export function appendUserAgentProduct(headers: Headers, product: string): Headers {
  const existing = headers.get("user-agent");
  if (existing?.split(/\s+/).includes(product)) return headers;
  headers.set("user-agent", joinUserAgentProducts(existing, product));
  return headers;
}

export function appendPackageUserAgent(headers: Headers): Headers {
  return appendUserAgentProduct(headers, buildPackageUserAgent());
}

export function withPackageUserAgent(inner?: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(
      init?.headers ??
        (typeof input === "object" && "headers" in input ? (input as Request).headers : undefined),
    );
    appendPackageUserAgent(headers);
    return (inner ?? globalThis.fetch)(input, { ...init, headers });
  };
}
