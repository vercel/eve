export type {
  SandboxBackendHandle,
  SandboxBackendSessionState,
  SandboxSeedFile,
  SandboxBackendTags,
  SandboxBackendRuntimeContext,
  SandboxBackendCreateInput,
  SandboxBackendPrewarmInput,
  SandboxBackendPrewarmResult,
  SandboxBackend,
} from "#shared/sandbox-backend.js";

/**
 * Thrown by a backend's `create` when the requested template was never
 * provisioned. Run `eve build` or call `prewarmAppSandboxes()` before
 * serving traffic. `backendName` and `templateKey` identify the missing
 * template. Use {@link SandboxTemplateNotProvisionedError.is} to narrow.
 */
export class SandboxTemplateNotProvisionedError extends Error {
  readonly backendName: string;
  readonly templateKey: string;

  constructor(input: { readonly backendName: string; readonly templateKey: string }) {
    super(
      `Sandbox template "${input.templateKey}" is not provisioned for backend "${input.backendName}". Run \`eve build\` or invoke \`prewarmAppSandboxes()\` before serving traffic.`,
    );
    this.name = "SandboxTemplateNotProvisionedError";
    this.backendName = input.backendName;
    this.templateKey = input.templateKey;
  }

  /** Type guard for {@link SandboxTemplateNotProvisionedError}. */
  static is(error: unknown): error is SandboxTemplateNotProvisionedError {
    return (
      error instanceof SandboxTemplateNotProvisionedError ||
      (typeof error === "object" &&
        error !== null &&
        (error as { readonly name?: unknown }).name === "SandboxTemplateNotProvisionedError" &&
        typeof (error as { readonly backendName?: unknown }).backendName === "string" &&
        typeof (error as { readonly templateKey?: unknown }).templateKey === "string")
    );
  }
}
