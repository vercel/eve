export interface GetVercelOidcTokenOptions {
  team?: string;
  project?: string;
  expirationBufferMs?: number;
}

export declare function getVercelOidcToken(options?: GetVercelOidcTokenOptions): Promise<string>;
