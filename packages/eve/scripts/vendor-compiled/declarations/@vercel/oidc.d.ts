export interface GetVercelOidcTokenOptions {
  team?: string;
  project?: string;
  expirationBufferMs?: number;
  /**
   * Exchanges the token for one whose `aud` is this value, through
   * `https://oidc.vercel.com/~token`. The exchanged token is cached until it expires.
   */
  audience?: string;
}

export declare function getVercelOidcToken(options?: GetVercelOidcTokenOptions): Promise<string>;
