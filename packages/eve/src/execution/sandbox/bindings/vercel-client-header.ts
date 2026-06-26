import { resolveInstalledPackageInfo } from "#internal/application/package.js";

/**
 * Request header eve stamps on every Vercel Sandbox API call so the sandbox
 * control plane can attribute traffic to eve and its version.
 */
export const EVE_SANDBOX_CLIENT_HEADER = "x-eve-client";

/**
 * Wraps a `fetch` implementation so every request carries the
 * {@link EVE_SANDBOX_CLIENT_HEADER} identifying the eve client and version.
 */
export function withEveSandboxClientHeader(
  inner: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const { name, version } = resolveInstalledPackageInfo();
  const clientId = `${name}/${version}`;

  return (input, init) => {
    const headers = new Headers(
      init?.headers ??
        (typeof input === "object" && input !== null && "headers" in input
          ? (input as Request).headers
          : undefined),
    );
    headers.set(EVE_SANDBOX_CLIENT_HEADER, clientId);
    return inner(input, { ...init, headers });
  };
}
