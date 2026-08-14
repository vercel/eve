import type { ResolvedDiscoveryProject } from "#discover/project.js";
import type { PackageManagerKind, PackageManagerSource } from "#setup/package-manager.js";

export type DiagnosticStatus = "pass" | "warn" | "fail" | "unknown";

export type Remediation =
  | { kind: "command"; command: string }
  | { kind: "message"; message: string };

export interface Diagnostic {
  id: string;
  status: DiagnosticStatus;
  summary: string;
  remediation: readonly Remediation[];
}

export type DiscoveryFacts =
  | { kind: "resolved"; project: ResolvedDiscoveryProject }
  | { kind: "unresolved"; message: string };

export type NodeFacts =
  | { kind: "available"; executable: string; version: string }
  | { kind: "unavailable"; message: string };

export type PackageManagerFacts =
  | {
      kind: "observed";
      manager: PackageManagerKind;
      source: PackageManagerSource;
      lockfiles: readonly string[];
      conflict: boolean;
    }
  | { kind: "unavailable"; message: string };

export type DependencyFacts =
  | { kind: "installed" }
  | { kind: "missing" }
  | { kind: "not-applicable" }
  | { kind: "unavailable"; message: string };

export type GitFacts =
  | { kind: "not-repository" }
  | {
      kind: "repository";
      head: "unborn" | "attached" | "detached";
      branch?: string;
      revision?: string;
      dirty: boolean;
      remotes: readonly string[];
    }
  | { kind: "unavailable"; message: string };
