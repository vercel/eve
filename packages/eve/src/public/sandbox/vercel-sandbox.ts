import type * as Vercel from "#compiled/@vercel/sandbox/index.js";
import type {
  NetworkPolicyMatch,
  NetworkPolicyRule,
  NetworkTransformer,
} from "#compiled/@vercel/sandbox/index.js";
import type { ConnectionAuthProvider, TokenResult } from "#runtime/connections/types.js";

type VercelCreateOptions = NonNullable<Parameters<typeof Vercel.Sandbox.create>[0]>;

type VercelUpdateOptions = Parameters<Vercel.Sandbox["update"]>[0];

type VercelSandboxInternalCreateOptions = {
  readonly [key: `__${string}`]: unknown;
};

type VercelSandboxAuthorCreateOptions<T> = T extends unknown
  ? Omit<T, "name" | "onResume" | "persistent" | "signal"> & VercelSandboxInternalCreateOptions
  : never;

/**
 * An eve-managed authenticated Vercel firewall rule.
 *
 * Interactive providers can initiate authorization when an authored tool's
 * `execute` first opens the sandbox. Hooks and channel events can reuse an
 * already-authorized provider but cannot initiate this interactive flow.
 */
export interface VercelSandboxAuthNetworkPolicyRule {
  /** Static authorization provider resolved for the active principal. */
  readonly auth: ConnectionAuthProvider;
  readonly match?: NetworkPolicyMatch;
  readonly transform: (token: TokenResult) => NetworkTransformer[];
}

/** A native Vercel rule or an eve-managed authenticated rule. */
export type VercelSandboxNetworkPolicyRule = NetworkPolicyRule | VercelSandboxAuthNetworkPolicyRule;

/** Route-level Vercel policy shape accepted by eve. */
export type VercelSandboxNetworkPolicy =
  | "allow-all"
  | "deny-all"
  | {
      readonly allow?:
        | string[]
        | Readonly<Record<string, readonly VercelSandboxNetworkPolicyRule[]>>;
      readonly subnets?: {
        readonly allow?: string[];
        readonly deny?: string[];
      };
    };

/**
 * Options accepted by `vercel(opts)`. Forwarded to Vercel Sandbox creation
 * for every fresh sandbox the framework creates (template at prewarm time,
 * session at first-time session-create). Skipped on resume (`Sandbox.get`)
 * since no create happens there.
 *
 * `networkPolicy` is deferred until after framework-owned base setup for
 * fresh templates and template-less sessions, so eve can install required
 * packages before authored bootstrap code runs. Template-backed session
 * creates receive it at creation time because the template already contains
 * the prepared base runtime.
 *
 * Framework-injected fields (`name`, `onResume`, `persistent`, `signal`) are
 * excluded: the framework owns those and overrides author-supplied values.
 *
 * `source` is honored only on the template create at prewarm time, so an
 * author-supplied snapshot, git revision, or tarball becomes the base layer
 * for the template. Framework setup, bootstrap, and seed files all run on
 * top, and the resulting framework-owned snapshot is what every later
 * session derives from, so `source` is stripped from the session-create path.
 * eve does not detect external snapshot changes; to pick up a rebuilt
 * external snapshot, force a template rebuild (e.g. by changing the sandbox
 * definition so its template key changes).
 *
 * The Vercel SDK create options remain available. Record-form `networkPolicy`
 * rules may attach `auth` for eve-managed credential resolution.
 */
export type VercelSandboxCreateOptions = VercelSandboxCreateOptionsWithAuth<VercelCreateOptions>;

type VercelSandboxCreateOptionsWithAuth<T> = T extends unknown
  ? Omit<VercelSandboxAuthorCreateOptions<T>, "networkPolicy"> & {
      /** Static policy whose individual rules may declare `auth`. */
      readonly networkPolicy?: VercelSandboxNetworkPolicy;
    }
  : never;

/**
 * Options accepted by the Vercel backend's `bootstrap({ use })` hook.
 * Tracks the Vercel SDK's `Sandbox.update(...)` parameter because bootstrap
 * applies its options to the template via `sandbox.update(...)` after
 * `Sandbox.create()` and before the snapshot is captured. The Vercel
 * SDK persists `update`-d settings on the sandbox so they survive into
 * the snapshot, which becomes the seed for every later session.
 *
 * Today this is the same shape as
 * {@link VercelSandboxSessionUseOptions}; both are exposed as separate
 * named aliases so future divergence is non-breaking.
 */
export type VercelSandboxBootstrapUseOptions = VercelUpdateOptions;

/**
 * Options accepted by the Vercel backend's `onSession({ use })` hook.
 * Tracks the Vercel SDK's `Sandbox.update(...)` parameter; passed values are
 * applied to the live session via the SDK's `update`.
 */
export type VercelSandboxSessionUseOptions = VercelUpdateOptions;
