/** Raised when a keyed tool session opens a sandbox on a provider that cannot keep it. */
export class ToolSessionSandboxUnsupportedError extends Error {
  constructor(providerName: string) {
    super(
      `Sandbox provider "${providerName}" cannot keep a sandbox between invokeTool calls, ` +
        "so a call with a key cannot open one. Call without a key for a sandbox that lasts " +
        "one call, or use Vercel Sandbox, just-bash, or a custom provider that sets `toolSessions: true`.",
    );
    this.name = "ToolSessionSandboxUnsupportedError";
  }
}
