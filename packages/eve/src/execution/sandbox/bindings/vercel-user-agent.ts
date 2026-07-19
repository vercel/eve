import { appendPackageUserAgent } from "#internal/user-agent.js";

/**
 * Wraps a `fetch` implementation so every request's `user-agent` ends with the
 * installed package product token.
 */
export function withSandboxUserAgent(
  inner: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(
      init?.headers ??
        (typeof input === "object" && input !== null && "headers" in input
          ? (input as Request).headers
          : undefined),
    );
    appendPackageUserAgent(headers);
    return inner(input, { ...init, headers });
  };
}
