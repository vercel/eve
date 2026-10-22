type SandboxTemplateNotProvisionedInput =
  /** The build recorded no prepared artifact for this agent node. */
  | { readonly nodeId: string; readonly providerName: string }
  /** The build recorded an artifact, but the provider can no longer find its template. */
  | { readonly providerName: string; readonly templateKey: string };

export class SandboxTemplateNotProvisionedError extends Error {
  readonly providerName: string;
  readonly templateKey: string;

  constructor(input: SandboxTemplateNotProvisionedInput) {
    super(
      "nodeId" in input
        ? `No prepared "${input.providerName}" sandbox environment is recorded for agent node "${input.nodeId}". ` +
            "eve prepares sandbox environments during `eve build` and never prepares them in production. " +
            "Run `eve build` without `--skip-sandbox-prewarm` and deploy that output with this runtime."
        : `Sandbox template "${input.templateKey}" for provider "${input.providerName}" was not found. ` +
            "It was deleted or expired after the build, or the build created it on a different machine or Docker daemon. " +
            "Run `eve build` again where this runtime runs, or redeploy, to recreate it.",
    );
    this.name = "SandboxTemplateNotProvisionedError";
    this.providerName = input.providerName;
    this.templateKey = "nodeId" in input ? input.nodeId : input.templateKey;
  }

  static is(error: unknown): error is SandboxTemplateNotProvisionedError {
    return (
      error instanceof SandboxTemplateNotProvisionedError ||
      (typeof error === "object" &&
        error !== null &&
        Reflect.get(error, "name") === "SandboxTemplateNotProvisionedError" &&
        typeof Reflect.get(error, "providerName") === "string" &&
        typeof Reflect.get(error, "templateKey") === "string")
    );
  }
}
