export interface SandboxDeleteOptions {
  readonly abortSignal?: AbortSignal;
}

export interface SandboxProviderResourceFile {
  readonly content: string | Uint8Array;
  readonly relativePath: string;
}

export type SandboxPreparedArtifact =
  | null
  | boolean
  | number
  | string
  | readonly SandboxPreparedArtifact[]
  | { readonly [key: string]: SandboxPreparedArtifact };

export function isSandboxPreparedArtifact(value: unknown): value is SandboxPreparedArtifact {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isSandboxPreparedArtifact);
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every(isSandboxPreparedArtifact)
  );
}

export interface SandboxProviderFiles {
  list(): Promise<readonly string[]>;
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
}
