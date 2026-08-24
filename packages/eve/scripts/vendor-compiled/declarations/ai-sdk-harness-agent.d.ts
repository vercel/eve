export interface HarnessAgentSession {
  destroy(): Promise<void>;
}

export declare class HarnessAgent {
  constructor(settings: {
    readonly harness: unknown;
    readonly id?: string;
    readonly instructions?: string;
    readonly skills?: ReadonlyArray<{
      readonly name: string;
      readonly description: string;
      readonly content: string;
      readonly files?: ReadonlyArray<{ readonly path: string; readonly content: string }>;
    }>;
    readonly output?: unknown;
    readonly permissionMode: "allow-all";
    readonly sandboxConfig: { readonly workDir: string };
  });
  createSession(options: {
    readonly sandboxSession: unknown;
    readonly abortSignal?: AbortSignal;
  }): Promise<HarnessAgentSession>;
  generate(options: {
    readonly session: HarnessAgentSession;
    readonly prompt: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<{ readonly text: string; readonly output: unknown }>;
}
