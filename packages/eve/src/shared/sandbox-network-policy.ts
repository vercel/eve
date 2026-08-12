import type * as Vercel from "#compiled/@vercel/sandbox/index.js";

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
export type SandboxNetworkPolicy = Vercel.NetworkPolicy;

/**
 * Mutable box tracking the network policy currently in effect on a live
 * sandbox. Seeded with the policy the sandbox was created under and passed
 * into {@link buildSandboxSession}, whose `setNetworkPolicy` wrapper updates
 * `current` after every policy change it accepts, so the resulting
 * session's `getNetworkPolicy()` stays accurate.
 *
 * Backends whose `useSessionFn` applies a policy straight to the provider
 * SDK (bypassing that wrapper) must write `current` themselves — and must
 * share the same ref instance across every session built for that handle,
 * or `getNetworkPolicy()` on one session won't see updates made through
 * another.
 */
export interface SandboxNetworkPolicyRef {
  current: SandboxNetworkPolicy;
}
