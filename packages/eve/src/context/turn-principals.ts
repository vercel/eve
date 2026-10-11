import type { SessionAuthContext } from "#channel/types.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, SessionKey } from "#context/keys.js";

/**
 * The active turn's caller and, when it differs, its initiator, read the same
 * way for every consumer that attributes work to a person. `undefined` when
 * the turn has no authenticated caller. Anonymous principals read as absent:
 * every anonymous caller shares one synthetic identity, so one cannot be told
 * apart from another, or vouched for.
 */
export function readTurnPrincipals():
  | { readonly current: SessionAuthContext; readonly initiator?: SessionAuthContext }
  | undefined {
  const context = contextStorage.getStore();
  const session = context?.get(SessionKey)?.auth;
  const current = identified(context?.get(AuthKey) ?? session?.current);
  if (current === undefined) return undefined;
  const initiator = identified(context?.get(InitiatorAuthKey) ?? session?.initiator);
  return initiator === undefined || initiator === current ? { current } : { current, initiator };
}

function identified(auth: SessionAuthContext | null | undefined): SessionAuthContext | undefined {
  return auth === null || auth === undefined || auth.principalType === "anonymous"
    ? undefined
    : auth;
}
