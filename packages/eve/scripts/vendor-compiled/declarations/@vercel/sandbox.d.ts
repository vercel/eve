// The firewall network-policy types are copied verbatim from the installed
// `@vercel/sandbox` at vendor time (see scripts/vendor-compiled/@vercel/sandbox.mjs)
// so the credential-brokering surface never drifts from the SDK.
import type { NetworkPolicy } from "./network-policy.js";

export type {
  NetworkPolicy,
  NetworkPolicyKeyValueMatcher,
  NetworkPolicyMatch,
  NetworkPolicyMatcher,
  NetworkPolicyRule,
  NetworkTransformer,
} from "./network-policy.js";

export interface SandboxKeepLastSnapshotsConfig {
  count: number;
  expiration?: number | undefined;
  deleteEvicted?: boolean | undefined;
}

export interface SandboxUpdateParams {
  currentSnapshotId?: string | undefined;
  keepLastSnapshots?: SandboxKeepLastSnapshotsConfig | null | undefined;
  networkPolicy?: NetworkPolicy | undefined;
  persistent?: boolean | undefined;
  ports?: number[] | undefined;
  resources?: { vcpus?: number | undefined } | undefined;
  snapshotExpiration?: number | undefined;
  tags?: Record<string, string> | undefined;
  timeout?: number | undefined;
}

export interface SandboxCreateOptions {
  [key: `__${string}`]: unknown;
  env?: Record<string, string> | undefined;
  name?: string | undefined;
  networkPolicy?: NetworkPolicy | undefined;
  onResume?: ((sandbox: Sandbox) => Promise<void>) | undefined;
  persistent?: boolean | undefined;
  ports?: number[] | undefined;
  resources?: { vcpus?: number | undefined } | undefined;
  runtime?: string | undefined;
  signal?: AbortSignal | undefined;
  snapshotExpiration?: number | undefined;
  source?: unknown;
  tags?: Record<string, string> | undefined;
  timeout?: number | undefined;
}

export interface SandboxGetOptions {
  name: string;
  onResume?: ((sandbox: Sandbox) => Promise<void>) | undefined;
  resume?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface SandboxRunCommandParams {
  args?: readonly string[] | undefined;
  cmd: string;
  cwd?: string | undefined;
  detached?: boolean | undefined;
  env?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  sudo?: boolean | undefined;
}

export interface SandboxRmOptions {
  force?: boolean | undefined;
  recursive?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export declare class FileSystem {
  rm(path: string, options?: SandboxRmOptions): Promise<void>;
  unlink(path: string, options?: { signal?: AbortSignal | undefined }): Promise<void>;
}

export interface SandboxCommandLogMessage {
  data: string;
  stream: "stdout" | "stderr";
}

export declare class SandboxCommand {
  readonly cmdId: string;
  readonly cwd: string;
  exitCode: number | null;
  logs(opts?: {
    signal?: AbortSignal | undefined;
  }): AsyncGenerator<SandboxCommandLogMessage, void, void>;
  wait(opts?: { signal?: AbortSignal | undefined }): Promise<SandboxCommandFinished>;
  stdout(opts?: { signal?: AbortSignal | undefined }): Promise<string>;
  stderr(opts?: { signal?: AbortSignal | undefined }): Promise<string>;
  kill(signal?: string, opts?: { abortSignal?: AbortSignal | undefined }): Promise<void>;
}

export interface SandboxCommandFinished extends SandboxCommand {
  exitCode: number;
}

export type SandboxCommandResult = SandboxCommandFinished;

export declare class Sandbox {
  currentSnapshotId?: string | undefined;
  readonly fs: FileSystem;
  id: string;
  name: string;
  networkPolicy?: NetworkPolicy | undefined;
  persistent: boolean;
  status: string;
  tags?: Record<string, string> | undefined;
  static create(options?: SandboxCreateOptions): Promise<Sandbox>;
  static get(options: SandboxGetOptions): Promise<Sandbox>;
  domain(port: number): string;
  readFile(file: { path: string }): Promise<ReadableStream<Uint8Array> | null>;
  readFileToBuffer(file: { path: string }): Promise<Buffer | null>;
  runCommand(input: SandboxRunCommandParams & { detached: true }): Promise<SandboxCommand>;
  runCommand(input: SandboxRunCommandParams): Promise<SandboxCommandFinished>;
  snapshot(options?: unknown): Promise<{ snapshotId: string }>;
  stop(options?: unknown): Promise<void>;
  update(
    params: SandboxUpdateParams,
    opts?: { signal?: AbortSignal | undefined } | undefined,
  ): Promise<void>;
  writeFiles(
    files: readonly { content: string | Uint8Array; path: string }[],
    options?: unknown,
  ): Promise<void>;
  [key: string]: any;
}
