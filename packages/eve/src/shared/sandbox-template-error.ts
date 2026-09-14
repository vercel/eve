export class SandboxTemplateNotProvisionedError extends Error {
  readonly forceRebuild: boolean;
  readonly providerName: string;
  readonly templateKey: string;

  constructor(input: {
    readonly forceRebuild?: boolean;
    readonly providerName: string;
    readonly templateKey: string;
  }) {
    super(
      `Sandbox template "${input.templateKey}" is not provisioned for provider "${input.providerName}". Run \`eve build\` before serving traffic.`,
    );
    this.name = "SandboxTemplateNotProvisionedError";
    this.forceRebuild = input.forceRebuild ?? true;
    this.providerName = input.providerName;
    this.templateKey = input.templateKey;
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
