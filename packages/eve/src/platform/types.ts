export type DeploymentEnvironmentKind = "development" | "preview" | "production";

export interface DeploymentBuild {
  readonly deployedAt: string | undefined;
  readonly gitBranch: string | undefined;
  readonly gitSha: string | undefined;
}

export interface PlatformDeployment {
  environmentKind(): DeploymentEnvironmentKind | undefined;
  deploymentId(): string | undefined;
  build(): DeploymentBuild | undefined;
  publicHost(): string | undefined;
}

export interface PlatformIdentity {
  token(): Promise<string>;
  ambientToken(): string | undefined;
}

export type BuildTarget = "vercel" | "node";

export interface PlatformBuild {
  target(): BuildTarget;
}

export interface Platform {
  readonly build: PlatformBuild;
  readonly deployment: PlatformDeployment;
  readonly identity: PlatformIdentity;
}
