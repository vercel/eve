import type { TrustedForwarders } from "#channel/forwarded-principal.js";
import type { SessionAuthContext } from "#channel/types.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("eve.channel.remote-callback");

/**
 * Authorizes a request that nominates a callback destination (`callback`,
 * `activityObserver`). This deployment authenticates its callbacks with its
 * own credentials, so only a caller the deployment explicitly trusts through
 * `trustedForwarders` may choose where those credentials are sent. A principal
 * type alone is a classification, not an origin authorization: `jwtHmac()`
 * classifies every valid token as `service`. Local `eve dev` is exempt.
 *
 * `forwarderTrusted` short-circuits the policy when it already accepted this
 * caller for a forwarded principal on the same request, so the predicate runs
 * at most once per request.
 */
export async function authorizeRemoteCallback(input: {
  readonly body: { readonly activityObserver?: unknown; readonly callback?: unknown };
  readonly forwarder: SessionAuthContext;
  readonly forwarderTrusted: boolean;
  readonly trustedForwarders: TrustedForwarders | undefined;
}): Promise<Response | null> {
  if (input.body.callback === undefined && input.body.activityObserver === undefined) return null;
  if (input.forwarderTrusted) return null;
  if (isEveDevEnvironment() && process.env.VERCEL !== "1") return null;

  if (input.trustedForwarders === undefined) {
    return Response.json(
      {
        error:
          "This deployment does not accept remote callbacks. Configure trustedForwarders on the eve channel to name the parents that may delegate work to it.",
        ok: false,
      },
      { status: 403 },
    );
  }

  let accepted: boolean;
  try {
    accepted = await input.trustedForwarders(input.forwarder);
  } catch (error) {
    const errorId = logError(log, "trustedForwarders handler failed", error, {
      forwarder: input.forwarder.principalId,
    });
    return Response.json(
      { error: "trustedForwarders handler failed.", errorId, ok: false },
      { status: 500 },
    );
  }
  if (accepted) return null;
  return Response.json(
    {
      error: "Caller is not authorized to delegate work with a callback to this deployment.",
      ok: false,
    },
    { status: 403 },
  );
}
