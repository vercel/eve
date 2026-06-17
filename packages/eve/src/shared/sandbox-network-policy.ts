import type { NetworkPolicy } from "#compiled/@vercel/sandbox/index.js";

/**
 * Firewall network policy applied to a live sandbox session.
 *
 * eve-owned alias of the backend network-policy shape. Use it to restrict
 * egress (`"deny-all"`, an allow-list) or to broker credentials onto
 * outgoing requests. A per-domain `transform` injects headers at the
 * firewall so secrets never enter the sandbox process:
 *
 * ```ts
 * const sandbox = await ctx.getSandbox();
 * await sandbox.setNetworkPolicy({
 *   allow: {
 *     "github.com": [{ transform: [{ headers: { authorization: "Basic ..." } }] }],
 *     "*": [],
 *   },
 * });
 * ```
 *
 * The Docker backend honors only the coarse `"allow-all"` and
 * `"deny-all"` policies; the just-bash backend rejects `setNetworkPolicy`
 * entirely (its network policy is fixed at sandbox creation and it runs
 * no binaries to govern).
 */
export type SandboxNetworkPolicy = NetworkPolicy;
