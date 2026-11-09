type SandboxTemplateNotProvisionedInput =
  /** The build recorded no prepared artifact for this agent node. */
  | { readonly nodeId: string; readonly providerName: string }
  /**
   * The provider cannot use the recorded template. Callers that know why pass
   * `reason`; the default message names no cause, because callers raise this for
   * several different ones.
   */
  | { readonly providerName: string; readonly reason?: string; readonly templateKey: string };

export class SandboxTemplateNotProvisionedError extends Error {
  readonly providerName: string;
  /** The provider's template identifier, or the agent node id when the build recorded no artifact. */
  readonly templateKey: string;

  constructor(input: SandboxTemplateNotProvisionedInput) {
    super(
      "nodeId" in input
        ? `No prepared "${input.providerName}" sandbox environment is recorded for agent node "${input.nodeId}". ` +
            "eve prepares sandbox environments during `eve build` and never prepares them in production. " +
            "Run `eve build` without `--skip-sandbox-prewarm` and deploy that output with this runtime."
        : `Sandbox template "${input.templateKey}" for provider "${input.providerName}" is not available to this runtime. ` +
            (input.reason === undefined ? "" : `${input.reason} `) +
            "The runtime only uses templates that `eve build` prepared and never recreates them. " +
            "Run `eve build` again and deploy its output.",
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
