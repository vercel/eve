import { localDev, vercelOidc } from "eve/channels/auth";
import { type EveAuthFn, eveChannel } from "eve/channels/eve";

/**
 * eve's local-development authenticator: admits loopback callers on a development server.
 */
const localDevAuth = localDev();

/**
 * Dev-only: present a trusted local session as an authenticated user.
 *
 * @remarks
 * The Notion connection is user-scoped, and `localDev()` yields a `local-dev` principal, so
 * user-scoped tool calls from the dev TUI would fail with `principal_required`. This shim
 * upgrades whatever `localDev()` admits to a `user` principal and returns `null` for the rest, so
 * it never affects production. `allowAgentInfo` keeps `GET /eve/v1/info` readable for that
 * caller, which the dev TUI and `eve eval` need and a `user` principal doesn't get by default.
 *
 * @param request - The inbound request to authenticate.
 * @returns A user principal for a trusted local caller, or `null` to defer to the next strategy.
 */
const localDevUser: EveAuthFn = async (request) => {
  const local = await localDevAuth(request);
  return local
    ? { ...local, allowAgentInfo: true, principalType: "user" }
    : null;
};

export default eveChannel({ auth: [localDevUser, vercelOidc()] });
