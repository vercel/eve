import type { PackageManagerKind } from "../../package-manager.js";

export interface PackageManagerInvocation {
  readonly args: readonly string[];
  readonly command: string;
  readonly shell?: boolean;
}

export interface PackageManagerConfigurationResult {
  readonly filesSkipped: readonly string[];
  readonly filesWritten: readonly string[];
}

export interface PackageManagerConfigurationOptions {
  readonly workspaceProbeRoot?: string;
}

export interface PackageManagerInstallOptions {
  readonly autoApprove?: boolean;
  readonly bypassMinimumReleaseAge?: boolean;
  readonly ignoreWorkspace?: boolean;
  readonly progressDetails?: boolean;
  readonly skipPeerDependencyResolution?: boolean;
}

export interface PackageManagerStrategy {
  readonly kind: PackageManagerKind;
  readonly scaffoldFiles: Readonly<Record<string, string>>;
  applyProjectConfiguration(
    projectRoot: string,
    options?: PackageManagerConfigurationOptions,
  ): Promise<PackageManagerConfigurationResult>;
  devArguments(): readonly string[];
  installArguments(options: PackageManagerInstallOptions): readonly string[];
  prepareArguments(projectRoot: string, args: readonly string[]): readonly string[];
  resolveInvocation(args: readonly string[]): PackageManagerInvocation;
}
