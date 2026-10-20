/**
 * Credential brokering for eve's built-in extensions. Not public API: the
 * user's sandbox network policy stays the limit, and these rules only attach
 * to hosts it already allows.
 */
export {
  addSandboxNetworkCredentials,
  createSandboxNetworkPolicyControl,
} from "#execution/sandbox/network-policy.js";
