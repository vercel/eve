import type { PackageManagerKind } from "../../package-manager.js";

/** Executable and arguments used to invoke a package manager. */
export interface PackageManagerInvocation {
  readonly args: readonly string[];
  readonly command: string;
  readonly shell?: boolean;
}

/** Files changed while applying package-manager-owned project configuration. */
export interface PackageManagerConfigurationResult {
  readonly filesSkipped: readonly string[];
  readonly filesWritten: readonly string[];
}

/** Context for manager-owned project configuration. */
export interface PackageManagerConfigurationOptions {
  /**
   * Final project path used to discover ancestor workspaces. This differs from
   * `projectRoot` only when a scaffold is staged in a temporary directory
   * before being moved into place.
   */
  readonly workspaceProbeRoot?: string;
}

export interface PackageManagerInstallOptions {
  /** Disables the manager's minimum-release-age cooldown for this run when supported. */
  readonly bypassMinimumReleaseAge?: boolean;
  /** Resolves the project standalone even when an ancestor workspace exists. */
  readonly ignoreWorkspace?: boolean;
  /** Requests verbose package-manager output for a live progress display. */
  readonly progressDetails?: boolean;
}

/**
 * Package-manager-specific command and generated-project behavior.
 *
 * Process lifecycle and output handling remain shared; each strategy owns the
 * arguments, executable resolution, and project files understood by its manager.
 */
export interface PackageManagerStrategy {
  /** Package manager represented by this strategy. */
  readonly kind: PackageManagerKind;
  /** Manager-owned files included when creating a fresh project. */
  readonly scaffoldFiles: Readonly<Record<string, string>>;
  /** Adds or reconciles manager-owned configuration in an existing project. */
  applyProjectConfiguration(
    projectRoot: string,
    options?: PackageManagerConfigurationOptions,
  ): Promise<PackageManagerConfigurationResult>;
  /** Arguments that run the project-local eve development command. */
  devArguments(): readonly string[];
  /** Arguments that install project dependencies. */
  installArguments(options: PackageManagerInstallOptions): readonly string[];
  /** Adds any project-scoping arguments required before command execution. */
  prepareArguments(projectRoot: string, args: readonly string[]): readonly string[];
  /** Resolves the executable exposed by the current host environment. */
  resolveInvocation(args: readonly string[]): PackageManagerInvocation;
}
