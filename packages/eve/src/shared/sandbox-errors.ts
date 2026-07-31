/**
 * Signals that a provider template reference can no longer be opened.
 */
export class SandboxTemplateUnavailableError extends Error {
  readonly provider: string;
  readonly templateKey: string;

  constructor(input: { readonly provider: string; readonly templateKey: string }) {
    super(
      `Sandbox template "${input.templateKey}" is unavailable from provider "${input.provider}". Run \`eve build\` before serving traffic.`,
    );
    this.name = "SandboxTemplateUnavailableError";
    this.provider = input.provider;
    this.templateKey = input.templateKey;
  }

  static is(error: unknown): error is SandboxTemplateUnavailableError {
    return (
      error instanceof SandboxTemplateUnavailableError ||
      (typeof error === "object" &&
        error !== null &&
        Reflect.get(error, "name") === "SandboxTemplateUnavailableError" &&
        typeof Reflect.get(error, "provider") === "string" &&
        typeof Reflect.get(error, "templateKey") === "string")
    );
  }
}

/**
 * Signals that a persisted sandbox resource can no longer be restored.
 */
export class SandboxResourceUnavailableError extends Error {
  readonly provider: string;
  readonly sessionKey: string;

  constructor(input: { readonly provider: string; readonly sessionKey: string }) {
    super(
      `Persisted sandbox "${input.sessionKey}" is unavailable from provider "${input.provider}".`,
    );
    this.name = "SandboxResourceUnavailableError";
    this.provider = input.provider;
    this.sessionKey = input.sessionKey;
  }

  static is(error: unknown): error is SandboxResourceUnavailableError {
    return (
      error instanceof SandboxResourceUnavailableError ||
      (typeof error === "object" &&
        error !== null &&
        Reflect.get(error, "name") === "SandboxResourceUnavailableError" &&
        typeof Reflect.get(error, "provider") === "string" &&
        typeof Reflect.get(error, "sessionKey") === "string")
    );
  }
}
