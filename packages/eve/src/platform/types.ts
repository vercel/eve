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

export interface Platform {
  readonly deployment: PlatformDeployment;
  readonly identity: PlatformIdentity;
}
