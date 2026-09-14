import type { SandboxSession } from "#public/definitions/sandbox.js";
import type { SandboxDeleteOptions } from "#shared/sandbox-provider.js";

export interface SandboxSessionState {
  readonly configurationHash?: string;
  readonly metadata: Record<string, unknown>;
  readonly providerName: string;
  readonly sessionKey: string;
}

export interface SandboxState {
  readonly initialized: boolean;
  readonly session: SandboxSessionState | null;
}

export interface SandboxAccess {
  captureState(): Promise<SandboxState>;
  delete?(options?: SandboxDeleteOptions): Promise<void>;
  get(): Promise<SandboxSession | null>;
  stop(): Promise<void>;
}
