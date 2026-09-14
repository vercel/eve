/** The stable session address and every additive continuation alias. */
export interface SessionHookClaims {
  readonly stable: string;
  readonly aliases: readonly string[];
}

export function flattenSessionHookClaims(claims: SessionHookClaims): readonly string[] {
  return [claims.stable, ...claims.aliases];
}
