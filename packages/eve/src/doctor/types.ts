import type { ResolvedDiscoveryProject } from "#discover/project.js";
import type { PackageManagerKind, PackageManagerSource } from "#setup/package-manager.js";

export type DiagnosticStatus = "pass" | "warn" | "fail" | "unknown";

export type Remediation =
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "message"; readonly message: string };

export interface Diagnostic {
  readonly id: string;
  readonly status: DiagnosticStatus;
  readonly summary: string;
  readonly remediation: readonly Remediation[];
}

export type DiscoveryFacts =
  | { readonly kind: "resolved"; readonly project: ResolvedDiscoveryProject }
  | { readonly kind: "unresolved"; readonly message: string };

export type NodeFacts =
  | { readonly kind: "available"; readonly executable: string; readonly version: string }
  | { readonly kind: "unavailable"; readonly message: string };

export type PackageManagerFacts =
  | {
      readonly kind: "observed";
      readonly manager: PackageManagerKind;
      readonly source: PackageManagerSource;
      readonly lockfiles: readonly string[];
      readonly conflict: boolean;
    }
  | { readonly kind: "unavailable"; readonly message: string };

export type DependencyFacts =
  | { readonly kind: "installed" }
  | { readonly kind: "missing"; readonly dependencies: readonly string[] }
  | { readonly kind: "not-applicable" }
  | { readonly kind: "unavailable"; readonly message: string };

export type GitFacts =
  | { readonly kind: "not-repository" }
  | {
      readonly kind: "repository";
      readonly head: "unborn" | "attached" | "detached";
      readonly branch?: string;
      readonly revision?: string;
      readonly dirty: boolean;
      readonly remotes: readonly string[];
    }
  | { readonly kind: "unavailable"; readonly message: string };

export type VercelFacts =
  | { readonly kind: "authenticated" }
  | { readonly kind: "logged-out" }
  | { readonly kind: "cli-missing" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "skipped" };
