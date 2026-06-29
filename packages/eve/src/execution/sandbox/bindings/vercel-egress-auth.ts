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
  readonly buildPolicy: (credentials: ReadonlyMap<string, TokenResult>) => SandboxNetworkPolicy;
  readonly clearedPolicy: SandboxNetworkPolicy;
  readonly rules: ReadonlyMap<string, VercelManagedAuthRule>;
}

export interface VercelManagedAuthRule {
  readonly authorization: Readonly<AuthorizationDefinition>;
  readonly domain: string;
  readonly id: string;
}

export function extractVercelEgressAuth(options: VercelSandboxCreateOptions | undefined): {
  readonly egressAuth: VercelEgressAuth | undefined;
  readonly createOptions: VercelCreateOptions;
} {
  const { networkPolicy, ...createOptions } = options ?? {};
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
  const rules = new Map(discovered.map((rule) => [rule.id, rule]));
  const buildPolicy = (credentials: ReadonlyMap<string, TokenResult>): SandboxNetworkPolicy =>
    buildManagedPolicy(authoredPolicy, discovered, credentials);
  return {
    egressAuth: {
      buildPolicy,
      clearedPolicy: buildPolicy(new Map()),
      rules,
    },
    createOptions: createOptions as VercelCreateOptions,
  };
}

export async function resolveVercelEgressPolicy(
  egressAuth: VercelEgressAuth,
  sandboxScope: string,
): Promise<SandboxNetworkPolicy> {
  const entries: ResolvedCredentialEntry[] = await Promise.all(
    [...egressAuth.rules.values()].map(async (rule) => {
      const ruleId = rule.id;
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
          const signal = await startScopedAuthorization(scoped);
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
  return egressAuth.buildPolicy(credentials);
}

function discoverManagedRules(
  policy: VercelSandboxNetworkPolicy | undefined,
): Array<VercelManagedAuthRule & { readonly index: number }> {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy.allow)) return [];
  const rules: Array<VercelManagedAuthRule & { readonly index: number }> = [];
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
      rules.push({
        authorization: normalizeAuthorizationSpec(
          rule.auth,
          `vercel() egress rule "${domain}"[${index}]:`,
        ),
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
      return [];
    });
    if (compiled.length > 0 || domainRules.length === 0) allow[domain] = compiled;
  }
  return { allow, subnets: policy.subnets };
}
