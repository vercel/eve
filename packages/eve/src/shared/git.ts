import { Buffer } from "node:buffer";

import type { SandboxNetworkPolicy } from "./sandbox-network-policy.js";

/** Returns whether a value is a complete Git object SHA. */
export function isFullGitSha(value: string): boolean {
  return /^[a-f0-9]{40}$/iu.test(value);
}

/** Returns whether a value can safely be used as a Git ref. */
export function isValidGitRef(value: string): boolean {
  return !(
    value.length === 0 ||
    value.startsWith("-") ||
    value.endsWith(".") ||
    value.endsWith("/") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.includes("\\") ||
    value.split("/").some((part) => part.length === 0 || part.endsWith(".lock")) ||
    /[\x00-\x20~^:?*[]/u.test(value)
  );
}

/** Builds the token-free HTTPS remote used by GitHub fetches. */
export function gitHubRemoteUrl(input: { readonly owner: string; readonly repo: string }): string {
  return `https://github.com/${input.owner}/${input.repo}.git`;
}

/**
 * Brokers a GitHub installation token at the sandbox firewall without exposing
 * it to the process running git. codeload.github.com is required for redirects
 * from shallow fetches.
 */
export function gitHubGitBrokerNetworkPolicy(token: string): SandboxNetworkPolicy {
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const rule = [{ transform: [{ headers: { Authorization: authorization } }] }];
  return { allow: { "*": [], "github.com": rule, "codeload.github.com": rule } };
}
