/** Project identity and environment for a remote deployment. */
export type DeploymentIdentity = {
  readonly provider: "vercel";
  readonly projectName: string;
  readonly environment: string;
};
