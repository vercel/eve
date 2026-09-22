import type * as Vercel from "#compiled/@vercel/sandbox/index.js";

/**
 * Firewall network policy applied to a live sandbox session.
 *
 * eve-owned alias of the provider network-policy shape. Use it to restrict
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
 * The Docker provider honors only the coarse `"allow-all"` and
 * `"deny-all"` policies; the just-bash provider rejects `setNetworkPolicy`
 * entirely (its network policy is fixed at sandbox creation and it runs
 * no binaries to govern).
 */
export type SandboxNetworkPolicy = Vercel.NetworkPolicy;

/** Initial network configuration shared by network-capable sandbox providers. */
export interface SandboxNetworkOptions {
  readonly networkPolicy?: SandboxNetworkPolicy;
}

export function isSandboxNetworkPolicy(value: unknown): value is SandboxNetworkPolicy {
  if (value === "allow-all" || value === "deny-all") return true;
  if (!isRecord(value) || !hasOnlyKeys(value, ["allow", "subnets"])) return false;
  if (value.allow !== undefined && !isNetworkAllowList(value.allow)) return false;
  return value.subnets === undefined || isSubnetPolicy(value.subnets);
}

function isNetworkAllowList(value: unknown): boolean {
  if (isStringArray(value)) return true;
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (rules) => Array.isArray(rules) && rules.every(isNetworkPolicyRule),
  );
}

function isNetworkPolicyRule(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["forwardURL", "match", "transform"])) return false;
  if (value.match !== undefined && !isNetworkPolicyMatch(value.match)) return false;
  const hasTransform = value.transform !== undefined;
  const hasForwardUrl = value.forwardURL !== undefined;
  if (hasTransform === hasForwardUrl) return false;
  if (hasForwardUrl) return typeof value.forwardURL === "string";
  return (
    Array.isArray(value.transform) &&
    value.transform.every(
      (transform) =>
        isRecord(transform) &&
        hasOnlyKeys(transform, ["headers"]) &&
        (transform.headers === undefined || isStringRecord(transform.headers)),
    )
  );
}

function isNetworkPolicyMatch(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["headers", "method", "path", "queryString"])) {
    return false;
  }
  return (
    (value.path === undefined || isNetworkPolicyMatcher(value.path)) &&
    (value.method === undefined || isStringArray(value.method)) &&
    (value.queryString === undefined || isKeyValueMatcherArray(value.queryString)) &&
    (value.headers === undefined || isKeyValueMatcherArray(value.headers))
  );
}

function isKeyValueMatcherArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (matcher) =>
        isRecord(matcher) &&
        hasOnlyKeys(matcher, ["key", "value"]) &&
        (matcher.key === undefined || isNetworkPolicyMatcher(matcher.key)) &&
        (matcher.value === undefined || isNetworkPolicyMatcher(matcher.value)),
    )
  );
}

function isNetworkPolicyMatcher(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["exact", "regex", "startsWith"])) return false;
  const matchers = [value.exact, value.startsWith, value.regex];
  return (
    matchers.filter((matcher) => matcher !== undefined).length === 1 &&
    matchers.every((matcher) => matcher === undefined || typeof matcher === "string")
  );
}

function isSubnetPolicy(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["allow", "deny"]) &&
    (value.allow === undefined || isStringArray(value.allow)) &&
    (value.deny === undefined || isStringArray(value.deny))
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
