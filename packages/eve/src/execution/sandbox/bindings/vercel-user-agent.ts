import { resolveInstalledPackageInfo } from "#internal/application/package.js";

export function eveSandboxUserAgentToken(): string {
  const { name, version } = resolveInstalledPackageInfo();
  return `${name}/${version}`;
}

/**
 * Wraps a `fetch` implementation so every request's `user-agent` ends with the
 * {@link eveSandboxUserAgentToken} (e.g.: eve/0.18.1).
 */
export function withEveSandboxUserAgent(
  inner: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const token = eveSandboxUserAgentToken();

  return (input, init) => {
    const headers = new Headers(
      init?.headers ??
        (typeof input === "object" && input !== null && "headers" in input
          ? (input as Request).headers
          : undefined),
    );
    const existing = headers.get("user-agent");
    headers.set("user-agent", existing ? `${existing} ${token}` : token);
    return inner(input, { ...init, headers });
  };
}
