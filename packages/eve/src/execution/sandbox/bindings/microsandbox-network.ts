import { createHash } from "node:crypto";

import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type {
  NetworkPolicy as MicrosandboxNetworkPolicy,
  Rule as MicrosandboxRule,
  SandboxBuilder as MicrosandboxSandboxBuilder,
} from "microsandbox";

interface MicrosandboxSecretBuilderShape {
  allowAnyHostDangerous(enabled: boolean): this;
  allowHost(host: string): this;
  allowHostPattern(pattern: string): this;
  env(name: string): this;
  injectBasicAuth(enabled: boolean): this;
  injectBody(enabled: boolean): this;
  injectHeaders(enabled: boolean): this;
  injectQuery(enabled: boolean): this;
  placeholder(value: string): this;
  requireTlsIdentity(enabled: boolean): this;
  value(value: string): this;
}

interface MicrosandboxNetworkBuilderShape {
  enabled(enabled: boolean): this;
  policyJson(json: string): this;
  secret(
    configure: (secret: MicrosandboxSecretBuilderShape) => MicrosandboxSecretBuilderShape,
  ): this;
  trustHostCAs(enabled: boolean): this;
}

interface MicrosandboxTransformHeaderRule {
  readonly domain: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly match?: unknown;
  readonly placeholderHeaders: Readonly<Record<string, string>>;
}

interface MicrosandboxNativeNetworkPolicy {
  readonly default_egress: string;
  readonly default_ingress: string;
  readonly rules: readonly MicrosandboxNativeRule[];
}

interface MicrosandboxNativeRule {
  readonly action: string;
  readonly destination: MicrosandboxNativeDestination;
  readonly direction: string;
  readonly ports: readonly MicrosandboxNativePortRange[];
  readonly protocols: readonly string[];
}

type MicrosandboxNativeDestination =
  | "any"
  | { readonly cidr: string }
  | { readonly domain: string }
  | { readonly domain_suffix: string }
  | { readonly group: string };

interface MicrosandboxNativePortRange {
  readonly end: number;
  readonly start: number;
}

export interface MicrosandboxNetworkPlan {
  readonly disabled: boolean;
  readonly policy: MicrosandboxNetworkPolicy | null;
  readonly transformHeaderRules: readonly MicrosandboxTransformHeaderRule[];
}

export function applyMicrosandboxNetwork(
  builder: MicrosandboxSandboxBuilder,
  networkPolicy: SandboxNetworkPolicy | undefined,
): MicrosandboxSandboxBuilder {
  const networkPlan = createMicrosandboxNetworkPlan(networkPolicy);
  if (networkPlan.disabled) {
    return builder.disableNetwork();
  }
  if (networkPlan.policy === null && networkPlan.transformHeaderRules.length === 0) {
    return builder;
  }

  return builder.network((network: MicrosandboxNetworkBuilderShape) => {
    let next = network.enabled(true);
    if (networkPlan.policy !== null) {
      next = next.policyJson(serializeMicrosandboxNetworkPolicyJson(networkPlan.policy));
    }
    if (networkPlan.transformHeaderRules.length === 0) {
      return next;
    }

    next = next.trustHostCAs(true);
    for (const rule of networkPlan.transformHeaderRules) {
      for (const [headerName, headerValue] of Object.entries(rule.headers)) {
        const placeholder = rule.placeholderHeaders[headerName];
        if (placeholder === undefined) {
          continue;
        }
        const secretEnvName = createSecretEnvName(rule.domain, headerName, headerValue);
        next = next.secret((secret) => {
          let configured = secret
            .env(secretEnvName)
            .value(headerValue)
            .placeholder(placeholder)
            .injectHeaders(true)
            .injectBasicAuth(true)
            .injectQuery(false)
            .injectBody(false)
            .requireTlsIdentity(true);

          if (rule.domain === "*") {
            configured = configured.allowAnyHostDangerous(true);
          } else if (rule.domain.startsWith("*.")) {
            configured = configured.allowHostPattern(rule.domain);
          } else {
            configured = configured.allowHost(rule.domain);
          }

          return configured;
        });
      }
    }
    return next;
  });
}

export function serializeMicrosandboxNetworkPolicyJson(policy: MicrosandboxNetworkPolicy): string {
  const nativePolicy: MicrosandboxNativeNetworkPolicy = {
    default_egress: policy.defaultEgress,
    default_ingress: policy.defaultIngress,
    rules: policy.rules.map((rule) => ({
      action: rule.action,
      destination: serializeMicrosandboxNetworkDestination(rule.destination),
      direction: rule.direction,
      ports: rule.ports,
      protocols: rule.protocols,
    })),
  };

  return JSON.stringify(nativePolicy);
}

export function createMicrosandboxNetworkPlan(
  policy: SandboxNetworkPolicy | undefined,
): MicrosandboxNetworkPlan {
  if (policy === undefined || policy === "allow-all") {
    return {
      disabled: false,
      policy: {
        defaultEgress: "allow",
        defaultIngress: "deny",
        rules: [],
      },
      transformHeaderRules: [],
    };
  }

  if (policy === "deny-all") {
    return {
      disabled: true,
      policy: null,
      transformHeaderRules: [],
    };
  }

  const rules: MicrosandboxRule[] = [];
  const transformHeaderRules: MicrosandboxTransformHeaderRule[] = [];
  const allowEntries = normalizeAllowEntries(policy.allow);
  const allowsWildcard = allowEntries.some((entry) => entry.domain === "*");
  const defaultEgress = allowsWildcard ? "allow" : "deny";

  for (const cidr of policy.subnets?.deny ?? []) {
    rules.push({
      action: "deny",
      destination: { cidr, kind: "cidr" },
      direction: "egress",
      ports: [],
      protocols: [],
    });
  }

  for (const cidr of policy.subnets?.allow ?? []) {
    rules.push({
      action: "allow",
      destination: { cidr, kind: "cidr" },
      direction: "egress",
      ports: [],
      protocols: [],
    });
  }

  if (!allowsWildcard) {
    rules.push({
      action: "allow",
      destination: { kind: "any" },
      direction: "egress",
      ports: [{ start: 53, end: 53 }],
      protocols: ["udp", "tcp"],
    });
  }

  for (const entry of allowEntries) {
    if (entry.domain === "*") {
      continue;
    }

    rules.push({
      action: "allow",
      destination: domainToDestination(entry.domain),
      direction: "egress",
      ports: [],
      protocols: [],
    });

    for (const rule of entry.rules) {
      for (const transform of normalizeTransforms(rule.transform)) {
        if (Object.keys(transform.headers).length === 0) {
          continue;
        }
        transformHeaderRules.push({
          domain: entry.domain,
          headers: transform.headers,
          match: rule.match,
          placeholderHeaders: createPlaceholderHeaders(entry.domain, transform.headers),
        });
      }
    }
  }

  return {
    disabled: false,
    policy: {
      defaultEgress,
      defaultIngress: "deny",
      rules,
    },
    transformHeaderRules,
  };
}

export function createTransformBrokerEnvironment(
  plan: MicrosandboxNetworkPlan,
): Readonly<Record<string, string>> {
  if (plan.transformHeaderRules.length === 0) {
    return {};
  }

  const gitHeaderEntries = plan.transformHeaderRules.flatMap((rule) =>
    Object.entries(rule.placeholderHeaders)
      .filter(([headerName]) => headerName.toLowerCase() === "authorization")
      .flatMap(([headerName, placeholder]) =>
        rule.domain === "*" || rule.domain.startsWith("*.")
          ? []
          : [
              {
                key: `http.https://${rule.domain}/.extraheader`,
                value: `${headerName}: ${placeholder}`,
              },
            ],
      ),
  );
  const gitConfigEnvironment: Record<string, string> = {};
  if (gitHeaderEntries.length > 0) {
    gitConfigEnvironment.GIT_CONFIG_COUNT = String(gitHeaderEntries.length);
    gitHeaderEntries.forEach((entry, index) => {
      gitConfigEnvironment[`GIT_CONFIG_KEY_${index}`] = entry.key;
      gitConfigEnvironment[`GIT_CONFIG_VALUE_${index}`] = entry.value;
    });
  }

  return {
    EVE_MICROSANDBOX_NETWORK_TRANSFORMS: Buffer.from(
      JSON.stringify(plan.transformHeaderRules),
    ).toString("base64"),
    ...gitConfigEnvironment,
  };
}

interface VercelNetworkPolicyRule {
  readonly forwardURL?: string;
  readonly match?: unknown;
  readonly transform?: readonly { readonly headers?: Readonly<Record<string, string>> }[];
}

interface VercelNetworkPolicyObject {
  readonly allow?: readonly string[] | Readonly<Record<string, readonly VercelNetworkPolicyRule[]>>;
  readonly subnets?: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  };
}

function normalizeAllowEntries(
  allow: VercelNetworkPolicyObject["allow"],
): ReadonlyArray<{ readonly domain: string; readonly rules: readonly VercelNetworkPolicyRule[] }> {
  if (allow === undefined) {
    return [];
  }
  if (Array.isArray(allow)) {
    return allow.map((domain) => ({ domain, rules: [] }));
  }
  return Object.entries(allow).map(([domain, rules]) => ({
    domain,
    rules: Array.isArray(rules) ? rules : [],
  }));
}

function normalizeTransforms(
  transforms: VercelNetworkPolicyRule["transform"],
): ReadonlyArray<{ readonly headers: Readonly<Record<string, string>> }> {
  if (transforms === undefined) {
    return [];
  }
  return transforms.map((transform) => ({ headers: transform.headers ?? {} }));
}

function domainToDestination(domain: string): MicrosandboxRule["destination"] {
  if (domain.startsWith("*.")) {
    return { kind: "domainSuffix", suffix: domain.slice(2) };
  }
  return { domain, kind: "domain" };
}

function serializeMicrosandboxNetworkDestination(
  destination: MicrosandboxRule["destination"],
): MicrosandboxNativeDestination {
  switch (destination.kind) {
    case "any":
      return "any";
    case "cidr":
      return { cidr: destination.cidr ?? "" };
    case "domain":
      return { domain: destination.domain ?? "" };
    case "domainSuffix":
      return { domain_suffix: destination.suffix ?? "" };
    case "group":
      return { group: destination.group ?? "" };
    default:
      throw new Error("Unsupported microsandbox network destination kind.");
  }
}

function createPlaceholderHeaders(
  domain: string,
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const placeholders: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    placeholders[headerName] =
      `__EVE_MSB_SECRET_${createStableHash(`${domain}:${headerName}:${headerValue}`).slice(0, 24)}__`;
  }
  return placeholders;
}

function createSecretEnvName(domain: string, headerName: string, headerValue: string): string {
  return `EVE_MSB_SECRET_${createStableHash(`${domain}:${headerName}:${headerValue}`)
    .slice(0, 24)
    .toUpperCase()}`;
}

function createStableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
