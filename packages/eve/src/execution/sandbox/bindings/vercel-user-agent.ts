import { resolveInstalledPackageInfo } from "#internal/application/package.js";

/**
 * Product token eve appends to the `user-agent` on every Vercel Sandbox API
 * call so the sandbox control plane can attribute traffic to eve and its
 * version. Appended (not prepended) to preserve the SDK's leading
 * `vercel/sandbox/<version>` token, which the control plane parses.
 */
export function eveSandboxUserAgentToken(): string {
  const { name, version } = resolveInstalledPackageInfo();
  return `${name}/${version}`;
}

/**
 * Wraps a `fetch` implementation so every request's `user-agent` ends with the
 * {@link eveSandboxUserAgentToken}, identifying the eve client and version
 * while keeping any existing user-agent intact.
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
