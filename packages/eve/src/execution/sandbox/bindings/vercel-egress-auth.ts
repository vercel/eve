import type { NetworkPolicyRule } from "#compiled/@vercel/sandbox/index.js";
import { SandboxAuthorizationInterrupt } from "#execution/sandbox/authorization-interrupt.js";
import type { VercelCreateOptions } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { type AuthorizationSignal, requestAuthorization } from "#harness/authorization.js";
import { createLogger } from "#internal/logging.js";
import {
  ConnectionAuthorizationFailedError,
  isConnectionAuthorizationFailedError,
  isConnectionAuthorizationRequiredError,
} from "#public/connections/errors.js";
import type {
  VercelSandboxAuthNetworkPolicyRule,
  VercelSandboxCreateOptions,
  VercelSandboxCredentialResolution,
  VercelSandboxNetworkPolicy,
} from "#public/sandbox/vercel-sandbox.js";
import {
  completeScopedAuthorization,
  evictScopedToken,
  resolveScopedToken,
  startScopedAuthorization,
  type ScopedAuthorization,
} from "#runtime/connections/scoped-authorization.js";
import {
  type AuthorizationDefinition,
  supportsInteractiveAuthorization,
  type TokenResult,
} from "#runtime/connections/types.js";
import { normalizeAuthorizationSpec } from "#runtime/connections/validate-authorization.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";

const logger = createLogger("sandbox.vercel-egress-auth");

type ResolvedCredentialEntry =
  | {
      readonly kind: "authorization";
      readonly label: string;
      readonly signal: AuthorizationSignal;
    }
  | {
      readonly kind: "token";
      readonly label: string;
      readonly token: TokenResult;
    };

export interface VercelEgressAuth {
  readonly callbackBaseUrl?: string;
  readonly buildPolicy: (
    credentials: ReadonlyMap<string, TokenResult>,
    sandboxName?: string,
  ) => SandboxNetworkPolicy;
  readonly clearedPolicy: SandboxNetworkPolicy;
  readonly eagerRuleIds: readonly string[];
  readonly rules: ReadonlyMap<string, VercelManagedAuthRule>;
}

export interface VercelManagedAuthRule {
  readonly authorization: Readonly<AuthorizationDefinition>;
  readonly credentialResolution: VercelSandboxCredentialResolution;
  readonly domain: string;
  readonly id: string;
}

export function extractVercelEgressAuth(options: VercelSandboxCreateOptions | undefined): {
  readonly egressAuth: VercelEgressAuth | undefined;
  readonly createOptions: VercelCreateOptions;
} {
  const { authProxyBaseUrl, credentialResolution, networkPolicy, ...createOptions } = options ?? {};
  assertCredentialResolution(credentialResolution, "vercel():");
  const authoredPolicy = networkPolicy;
  const discovered = discoverManagedRules(authoredPolicy);
  if (discovered.length === 0) {
    return {
      egressAuth: undefined,
      createOptions:
        authoredPolicy === undefined
          ? (createOptions as VercelCreateOptions)
          : ({ ...createOptions, networkPolicy: authoredPolicy } as VercelCreateOptions),
    };
  }
  const defaultCredentialResolution = credentialResolution ?? "eager";
  const normalizedRules: Array<VercelManagedAuthRule & { readonly index: number }> = discovered.map(
    (rule) => ({
      ...rule,
      credentialResolution: rule.credentialResolution ?? defaultCredentialResolution,
    }),
  );
  rejectAuthoredForwardUrls(authoredPolicy);
  const callbackBaseUrl = resolveAuthProxyBaseUrl(authProxyBaseUrl, normalizedRules);
  const rules = new Map(normalizedRules.map((rule) => [rule.id, rule]));
  const buildPolicy = (
    credentials: ReadonlyMap<string, TokenResult>,
    sandboxName?: string,
  ): SandboxNetworkPolicy =>
    buildManagedPolicy(authoredPolicy, normalizedRules, credentials, callbackBaseUrl, sandboxName);
  return {
    egressAuth: {
      callbackBaseUrl,
      buildPolicy,
      clearedPolicy: buildPolicy(new Map()),
      eagerRuleIds: normalizedRules
        .filter((rule) => rule.credentialResolution === "eager")
        .map((rule) => rule.id),
      rules,
    },
    createOptions: createOptions as VercelCreateOptions,
  };
}

export async function resolveVercelEgressPolicy(
  egressAuth: VercelEgressAuth,
  sandboxScope: string,
  ruleIds: readonly string[] = egressAuth.eagerRuleIds,
  sandboxName?: string,
): Promise<{
  readonly credentials: ReadonlyMap<string, TokenResult>;
  readonly policy: SandboxNetworkPolicy;
  readonly unresolvedRuleIds: readonly string[];
}> {
  const entries: ResolvedCredentialEntry[] = await Promise.all(
    ruleIds.map(async (ruleId) => {
      const rule = egressAuth.rules.get(ruleId);
      if (rule === undefined) {
        throw new Error(`Unknown managed sandbox egress rule "${ruleId}".`);
      }
      const scoped: ScopedAuthorization = {
        authorization: rule.authorization,
        connection: { url: `https://${rule.domain}` },
        scope: `sandbox:${sandboxScope}:${rule.id}`,
      };
      const justAuthorized = await completeScopedAuthorization(scoped);

      try {
        return {
          kind: "token",
          label: ruleId,
          token: await resolveScopedToken(scoped),
        } as const;
      } catch (error) {
        if (isConnectionAuthorizationFailedError(error)) {
          throw error;
        }
        if (isConnectionAuthorizationRequiredError(error)) {
          if (justAuthorized) {
            throw new ConnectionAuthorizationFailedError(scoped.scope, {
              message:
                `Sandbox egress rule "${ruleId}" rejected the token immediately after ` +
                "authorization.",
              reason: "token_rejected_after_authorization",
              retryable: false,
            });
          }

          await evictScopedToken(scoped);
          const signal = await startScopedAuthorization(scoped, egressAuth.callbackBaseUrl);
          if (signal !== undefined) {
            return { kind: "authorization", label: ruleId, signal } as const;
          }
          if (supportsInteractiveAuthorization(rule.authorization)) {
            throw new ConnectionAuthorizationFailedError(scoped.scope, {
              message:
                `Sandbox egress rule "${ruleId}" requires sign-in, but no authorization ` +
                "callback URL could be minted for this run (missing session context).",
              reason: "authorization_callback_unavailable",
              retryable: false,
            });
          }
        }

        logger.warn("sandbox credential unavailable; leaving route closed", {
          ruleId,
          error,
        });
        return { kind: "token", label: ruleId, token: { token: "" } } as const;
      }
    }),
  );

  const challenges = entries.flatMap((entry) =>
    entry.kind === "authorization" ? entry.signal.challenges : [],
  );
  if (challenges.length > 0) {
    throw new SandboxAuthorizationInterrupt(requestAuthorization(challenges));
  }

  const credentials = new Map(
    entries
      .filter(
        (entry): entry is Extract<ResolvedCredentialEntry, { readonly kind: "token" }> =>
          entry.kind === "token" && entry.token.token.length > 0,
      )
      .map((entry) => [entry.label, entry.token] as const),
  );
  const unresolvedRuleIds = entries
    .filter(
      (entry): entry is Extract<ResolvedCredentialEntry, { readonly kind: "token" }> =>
        entry.kind === "token" && entry.token.token.length === 0,
    )
    .map((entry) => entry.label);
  return {
    credentials,
    policy: egressAuth.buildPolicy(credentials, sandboxName),
    unresolvedRuleIds,
  };
}

function discoverManagedRules(policy: VercelSandboxNetworkPolicy | undefined): Array<
  Omit<VercelManagedAuthRule, "credentialResolution"> & {
    credentialResolution?: VercelSandboxCredentialResolution;
    readonly index: number;
  }
> {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy.allow)) return [];
  const rules: Array<
    Omit<VercelManagedAuthRule, "credentialResolution"> & {
      credentialResolution?: VercelSandboxCredentialResolution;
      readonly index: number;
    }
  > = [];
  let domainIndex = 0;
  for (const [domain, domainRules] of Object.entries(policy.allow ?? {})) {
    for (const [index, rule] of domainRules.entries()) {
      if (!isAuthRule(rule)) continue;
      const id = `r${domainIndex}-${index}`;
      if (typeof rule.transform !== "function") {
        throw new Error(
          `vercel(): egress rule "${domain}"[${index}] must define a transform function.`,
        );
      }
      assertCredentialResolution(
        rule.credentialResolution,
        `vercel(): egress rule "${domain}"[${index}]:`,
      );
      rules.push({
        authorization: normalizeAuthorizationSpec(
          rule.auth,
          `vercel() egress rule "${domain}"[${index}]:`,
        ),
        credentialResolution: rule.credentialResolution,
        domain,
        id,
        index,
      });
    }
    domainIndex += 1;
  }
  return rules;
}

function isAuthRule(rule: unknown): rule is VercelSandboxAuthNetworkPolicyRule {
  return typeof rule === "object" && rule !== null && "auth" in rule;
}

function buildManagedPolicy(
  policy: VercelSandboxNetworkPolicy | undefined,
  managedRules: ReadonlyArray<VercelManagedAuthRule & { readonly index: number }>,
  credentials: ReadonlyMap<string, TokenResult>,
  callbackBaseUrl: string | undefined,
  sandboxName: string | undefined,
): SandboxNetworkPolicy {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy.allow)) {
    throw new Error("vercel(): managed `auth` rules require record-form `networkPolicy.allow`.");
  }
  const managedByLocation = new Map(
    managedRules.map((rule) => [`${rule.domain}:${rule.index}`, rule]),
  );
  const allow: Record<string, NetworkPolicyRule[]> = {};
  for (const [domain, domainRules] of Object.entries(policy.allow ?? {})) {
    const compiled = domainRules.flatMap((authoredRule, index): NetworkPolicyRule[] => {
      if (!isAuthRule(authoredRule)) return [authoredRule];
      const location = `${domain}:${index}`;
      const managed = managedByLocation.get(location);
      if (managed === undefined) {
        throw new Error(`vercel(): managed egress rule at "${location}" was not discovered.`);
      }
      const token = credentials.get(managed.id);
      if (token !== undefined) {
        const compiledRule: NetworkPolicyRule = {
          transform: authoredRule.transform(token),
        };
        if (authoredRule.match !== undefined) compiledRule.match = authoredRule.match;
        return [compiledRule];
      }
      if (managed.credentialResolution === "on-request" && sandboxName !== undefined) {
        const compiledRule: NetworkPolicyRule = {
          forwardURL:
            `${callbackBaseUrl}/eve/v1/sandbox/egress/${managed.id}/` +
            encodeURIComponent(sandboxName),
        };
        if (authoredRule.match !== undefined) compiledRule.match = authoredRule.match;
        return [compiledRule];
      }
      return [];
    });
    if (compiled.length > 0 || domainRules.length === 0) allow[domain] = compiled;
  }
  return { allow, subnets: policy.subnets };
}

function rejectAuthoredForwardUrls(policy: VercelSandboxNetworkPolicy | undefined): void {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy.allow)) return;
  for (const rules of Object.values(policy.allow ?? {})) {
    if (rules.some((rule) => "forwardURL" in rule && rule.forwardURL !== undefined)) {
      throw new Error(
        "vercel(): authored `forwardURL` rules cannot be combined with eve-managed `auth` rules.",
      );
    }
  }
}

function assertCredentialResolution(
  value: unknown,
  prefix: string,
): asserts value is VercelSandboxCredentialResolution | undefined {
  if (value !== undefined && value !== "eager" && value !== "on-request") {
    throw new Error(`${prefix} invalid credential resolution mode "${String(value)}".`);
  }
}

function resolveAuthProxyBaseUrl(
  authored: string | undefined,
  rules: readonly VercelManagedAuthRule[],
): string | undefined {
  if (!rules.some((rule) => rule.credentialResolution === "on-request")) return undefined;
  const candidate = authored ?? process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (candidate === undefined || candidate.trim().length === 0) {
    throw new Error(
      "vercel(): `authProxyBaseUrl` is required for on-request credential resolution outside a Vercel deployment.",
    );
  }
  const withScheme = candidate.includes("://") ? candidate : `https://${candidate}`;
  const url = new URL(withScheme);
  if (url.protocol !== "https:") {
    throw new Error("vercel(): `authProxyBaseUrl` must be a public HTTPS URL.");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
