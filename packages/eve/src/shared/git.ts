import { Buffer } from "node:buffer";

import type { SandboxNetworkPolicy } from "./sandbox-network-policy.js";

export function isFullGitSha(value: string): boolean {
  return /^[a-f0-9]{40}$/iu.test(value);
}

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
    value
      .split("/")
      .some((part) => part.length === 0 || part.startsWith(".") || part.endsWith(".lock")) ||
    // eslint-disable-next-line no-control-regex -- Git refs must reject ASCII control characters.
    /[\x00-\x20\x7f~^:?*[]/u.test(value)
  );
}

export function gitHubRemoteUrl(input: { readonly owner: string; readonly repo: string }): string {
  return `https://github.com/${input.owner}/${input.repo}.git`;
}

export function gitHubGitBrokerNetworkPolicy(token: string): SandboxNetworkPolicy {
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const rule = [{ transform: [{ headers: { Authorization: authorization } }] }];
  return { allow: { "*": [], "github.com": rule, "codeload.github.com": rule } };
}
