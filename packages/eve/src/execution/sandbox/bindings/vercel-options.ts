import type {
  VercelSandboxSessionOptions,
  VercelSandboxSource,
} from "#public/sandbox/vercel-sandbox.js";

export interface VercelCreateOptions extends VercelSandboxSessionOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly image?: string;
  readonly name?: string;
  readonly persistent?: boolean;
  readonly runtime?: string;
  readonly signal?: AbortSignal;
  readonly source?: VercelSandboxSource;
  readonly token?: string;
}
