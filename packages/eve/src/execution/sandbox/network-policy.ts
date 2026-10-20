import type * as Vercel from "#compiled/@vercel/sandbox/index.js";
import type {
  SandboxNetworkCredentials,
  SandboxNetworkPolicy,
} from "#shared/sandbox-network-policy.js";

type NetworkPolicyRule = Vercel.NetworkPolicyRule;

/** How a provider applies and recovers network policy for one session handle. */
export interface SandboxNetworkPolicyBinding {
  /**
   * Puts `policy` in force. `userPolicy` is the part the user owns, for
   * providers that persist it across resumes.
   */
  apply(policy: SandboxNetworkPolicy, userPolicy: SandboxNetworkPolicy): Promise<void>;
  /**
   * Returns the user's policy when this handle has not seen one yet. Rules on
   * `credentialHosts` may be eve's own leftovers and are about to be replaced.
   */
  readUserPolicy(credentialHosts: readonly string[]): Promise<SandboxNetworkPolicy>;
}

/** eve-internal credential surface on a session; deliberately not exported publicly. */
interface SandboxNetworkCredentialControl {
  /** Attaches `credentials` and returns the call that removes exactly them. */
  add(credentials: SandboxNetworkCredentials): Promise<() => Promise<void>>;
}

const networkCredentialControl = Symbol("eve.sandbox.networkCredentials");

export interface SandboxNetworkPolicyControl {
  readonly [networkCredentialControl]: SandboxNetworkCredentialControl;
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
}

/**
 * Owns a session's network policy: the user's policy is the limit, and eve's
 * credential rules are merged onto hosts it allows. Each `add` is its own
 * lease; on a host held by several, the newest wins, and releasing it brings
 * back the one below. Every write applies the merge, so a user
 * `setNetworkPolicy` keeps eve's credentials only where the new policy allows
 * them, and releasing every lease restores exactly the user's policy.
 */
export function createSandboxNetworkPolicyControl(
  binding: SandboxNetworkPolicyBinding,
): SandboxNetworkPolicyControl {
  let userPolicy: SandboxNetworkPolicy | undefined;
  const leases: SandboxNetworkCredentials[] = [];
  let queue: Promise<unknown> = Promise.resolve();

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  }

  async function applyMerged(user: SandboxNetworkPolicy): Promise<void> {
    await binding.apply(mergeSandboxNetworkCredentials(user, Object.assign({}, ...leases)), user);
  }

  function release(lease: SandboxNetworkCredentials): () => Promise<void> {
    return () =>
      serialized(async () => {
        const index = leases.indexOf(lease);
        if (index === -1 || userPolicy === undefined) return;
        leases.splice(index, 1);
        try {
          await applyMerged(userPolicy);
        } catch (error) {
          leases.splice(index, 0, lease);
          throw error;
        }
      });
  }

  return {
    [networkCredentialControl]: {
      add: (added) =>
        serialized(async () => {
          const hosts = Object.keys(added);
          const user = userPolicy ?? (await binding.readUserPolicy(hosts));
          const blocked = hosts.filter((host) => !allowsHost(user, host));
          if (blocked.length > 0) {
            throw new Error(
              `The sandbox network policy does not allow ${blocked.join(", ")}, so eve cannot attach credentials there. Allow ${blocked.length === 1 ? "this host" : "these hosts"} in the sandbox networkPolicy.`,
            );
          }
          const lease = { ...added };
          leases.push(lease);
          try {
            await applyMerged(user);
          } catch (error) {
            leases.pop();
            throw error;
          }
          userPolicy = user;
          return release(lease);
        }),
    },
    setNetworkPolicy: (policy) =>
      serialized(async () => {
        await applyMerged(policy);
        userPolicy = policy;
      }),
  };
}

/**
 * Attaches `credentials` for the length of `operation`, then removes them.
 * Throws when the session cannot broker credentials or its policy does not
 * allow every host.
 */
export async function withSandboxNetworkCredentials<T>(
  sandbox: object,
  credentials: SandboxNetworkCredentials,
  operation: () => Promise<T>,
): Promise<T> {
  const control = getSandboxNetworkCredentialControl(sandbox);
  const hosts = Object.keys(credentials);
  const release = await control.add(credentials);
  let outcome:
    | { readonly ok: true; readonly value: T }
    | { readonly error: unknown; readonly ok: false };
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error) {
    outcome = { error, ok: false };
  }
  try {
    await release();
  } catch (removalError) {
    throw new Error(
      `Could not remove brokered credentials for ${hosts.join(", ")} from the sandbox.`,
      {
        cause: outcome.ok ? removalError : new AggregateError([outcome.error, removalError]),
      },
    );
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/**
 * Attaches `credentials` for the rest of the session handle. Throws, without
 * writing a policy, when a host is outside the user's policy.
 */
export async function addSandboxNetworkCredentials(
  sandbox: object,
  credentials: SandboxNetworkCredentials,
): Promise<void> {
  await getSandboxNetworkCredentialControl(sandbox).add(credentials);
}

export function getSandboxNetworkCredentialControl(
  sandbox: object,
): SandboxNetworkCredentialControl {
  const control = (sandbox as Partial<SandboxNetworkPolicyControl>)[networkCredentialControl];
  if (control === undefined) {
    throw new Error(
      "Brokered credentials require a sandbox provider with mutable network policy (Vercel or microsandbox).",
    );
  }
  return control;
}

/**
 * Merges credential rules onto the hosts `user` allows; credentials for any
 * other host are left out, so the result never allows more than `user`.
 */
export function mergeSandboxNetworkCredentials(
  user: SandboxNetworkPolicy,
  credentials: SandboxNetworkCredentials,
): SandboxNetworkPolicy {
  const mutable = Object.fromEntries(
    Object.entries(credentials)
      .filter(([host]) => allowsHost(user, host))
      .map(([host, rules]) => [host, [...rules]]),
  );
  if (Object.keys(mutable).length === 0) return user;
  if (user === "allow-all") return { allow: { "*": [], ...mutable } };
  if (user === "deny-all") return user;
  return { ...user, allow: { ...allowRecord(user.allow), ...mutable } };
}

function allowRecord(
  allow: Exclude<SandboxNetworkPolicy, string>["allow"],
): Record<string, NetworkPolicyRule[]> {
  if (allow === undefined) return {};
  if (Array.isArray(allow)) return Object.fromEntries(allow.map((host) => [host, []]));
  return { ...allow };
}

function allowsHost(policy: SandboxNetworkPolicy, host: string): boolean {
  if (policy === "allow-all") return true;
  if (policy === "deny-all") return false;
  return Object.keys(allowRecord(policy.allow)).some(
    (entry) =>
      entry === "*" || entry === host || (entry.startsWith("*.") && host.endsWith(entry.slice(1))),
  );
}
