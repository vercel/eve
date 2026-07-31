type SandboxNetworkMatcher =
  | { readonly exact: string }
  | { readonly startsWith: string }
  | { readonly regex: string };

type SandboxNetworkRule = {
  readonly match?: {
    readonly headers?: Array<{
      readonly key?: SandboxNetworkMatcher;
      readonly value?: SandboxNetworkMatcher;
    }>;
    readonly method?: string[];
    readonly path?: SandboxNetworkMatcher;
    readonly queryString?: Array<{
      readonly key?: SandboxNetworkMatcher;
      readonly value?: SandboxNetworkMatcher;
    }>;
  };
} & (
  | {
      readonly forwardURL?: never;
      readonly transform: Array<{
        readonly headers?: Record<string, string>;
      }>;
    }
  | {
      readonly forwardURL: string;
      readonly transform?: never;
    }
);

/**
 * Firewall network policy applied to a live sandbox session.
 *
 * Use it to restrict egress (`"deny-all"`, an allow-list) or to broker
 * credentials onto outgoing requests. A per-domain `transform` injects
 * headers at the firewall so secrets never enter the sandbox process:
 *
 * ```ts
 * await sandbox.setNetworkPolicy({
 *   allow: {
 *     "github.com": [{ transform: [{ headers: { authorization: "Basic ..." } }] }],
 *     "*": [],
 *   },
 * });
 * ```
 *
 * The Docker provider supports only `"allow-all"` and `"deny-all"`.
 */
export type SandboxNetworkPolicy =
  | "allow-all"
  | "deny-all"
  | {
      readonly allow?: string[] | Record<string, SandboxNetworkRule[]>;
      readonly subnets?: {
        readonly allow?: string[];
        readonly deny?: string[];
      };
    };

/** Persisted policies cross an untyped serialization boundary and must be revalidated. */
export function isSandboxNetworkPolicy(value: unknown): value is SandboxNetworkPolicy {
  if (value === "allow-all" || value === "deny-all") {
    return true;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ["allow", "subnets"])) {
    return false;
  }
  return (
    (value.allow === undefined ||
      isStringArray(value.allow) ||
      isSandboxNetworkRuleMap(value.allow)) &&
    (value.subnets === undefined || isSandboxSubnetPolicy(value.subnets))
  );
}

function isSandboxNetworkRuleMap(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.values(value).every((rules) => Array.isArray(rules) && rules.every(isSandboxNetworkRule))
  );
}

function isSandboxNetworkRule(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["forwardURL", "match", "transform"])) {
    return false;
  }
  if (value.match !== undefined && !isSandboxNetworkMatch(value.match)) {
    return false;
  }
  if (typeof value.forwardURL === "string") {
    return value.transform === undefined;
  }
  return (
    value.forwardURL === undefined &&
    Array.isArray(value.transform) &&
    value.transform.every(isSandboxNetworkTransform)
  );
}

function isSandboxNetworkMatch(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["headers", "method", "path", "queryString"])) {
    return false;
  }
  return (
    (value.headers === undefined || isSandboxNetworkMatchEntries(value.headers)) &&
    (value.method === undefined || isStringArray(value.method)) &&
    (value.path === undefined || isSandboxNetworkMatcher(value.path)) &&
    (value.queryString === undefined || isSandboxNetworkMatchEntries(value.queryString))
  );
}

function isSandboxNetworkMatchEntries(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        hasOnlyKeys(entry, ["key", "value"]) &&
        (entry.key === undefined || isSandboxNetworkMatcher(entry.key)) &&
        (entry.value === undefined || isSandboxNetworkMatcher(entry.value)),
    )
  );
}

function isSandboxNetworkMatcher(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["exact", "regex", "startsWith"])) {
    return false;
  }
  const matchers = [value.exact, value.regex, value.startsWith];
  return matchers.filter((matcher) => typeof matcher === "string").length === 1;
}

function isSandboxNetworkTransform(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["headers"]) &&
    (value.headers === undefined || isStringRecord(value.headers))
  );
}

function isSandboxSubnetPolicy(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["allow", "deny"]) &&
    (value.allow === undefined || isStringArray(value.allow)) &&
    (value.deny === undefined || isStringArray(value.deny))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
