export interface LoadOptions {
  filename?: string;
  json?: boolean;
}

export function load(source: string, options?: LoadOptions): unknown;
