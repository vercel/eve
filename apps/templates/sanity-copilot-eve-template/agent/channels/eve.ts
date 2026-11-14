import { localDev, vercelOidc } from "eve/channels/auth";
import { type EveAuthFn, eveChannel } from "eve/channels/eve";

/** The `localDev()` authenticator that {@link localDevUser} wraps. */
const localDevAuth = localDev();

/**
 * Dev-only shim that presents a trusted local session as a signed-in user.
 *
 * @remarks
 * The Sanity and Notion connections are user-scoped, and an unlinked `eve dev` session resolves
 * to a `local-dev` principal that isn't a user, so their tool calls would fail with
 * `principal_required`. The shim only upgrades what `localDev()` admits and returns `null` for
 * everything else, so it never affects production. `allowAgentInfo` lets the dev TUI and
 * `eve eval` read the agent's info route as that user.
 *
 * @param request - The incoming request.
 * @returns The local principal as a user, or `null` when `localDev()` rejects the request.
 */
const localDevUser: EveAuthFn = async (request) => {
  const local = await localDevAuth(request);
  return local
    ? { ...local, allowAgentInfo: true, principalType: "user" }
    : null;
};

/**
 * eve HTTP channel auth, tried in order until one recognizes the caller.
 *
 * @remarks
 * `vercelOidc()` must come before the local fallback; otherwise the synthetic local principal
 * shadows a real Vercel user.
 */
export default eveChannel({ auth: [vercelOidc(), localDevUser] });
