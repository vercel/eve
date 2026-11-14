import {
  isConnectionAuthorizationFailedError,
  isConnectionAuthorizationRequiredError,
} from "#connections/errors.js";
import { SIGN_IN_DECLINED } from "#harness/hitl/sign-ins.js";
import type { SessionView } from "#harness/session-machine/view.js";
import { displayProperName } from "#protocol/session-projection/display-name.js";
import type { AuthorizationDefinition } from "#shared/connection-types.js";

/** What the person reads when a model call's sign-in fails: what happened, and what to do. */
export interface SignInFailureText {
  readonly message: string;
  readonly hint?: string;
}

/** A model call's sign-in: its scope, and its provider when eve still holds it. */
export interface ModelSignIn {
  readonly scope: string;
  readonly authorization?: Readonly<AuthorizationDefinition>;
}

/**
 * The person-facing text for a failed model-call sign-in. It reads the failure's `reason` and
 * the provider's display name, and never shows the internal scope.
 */
export function signInFailureText(
  view: SessionView,
  error: unknown,
  signIn: ModelSignIn,
): SignInFailureText {
  const name = providerName(view, signIn);
  const reason = isConnectionAuthorizationFailedError(error) ? error.reason : undefined;
  switch (reason) {
    case "sign_in_unavailable":
      return {
        message: `A scheduled run can't ask you to sign in to ${name}.`,
        hint: `Send a message to sign in to ${name}, then run it again.`,
      };
    case "sign_in_cancelled":
      return {
        message: `The sign-in to ${name} ended without finishing.`,
        hint: "Send a new message to sign in again.",
      };
    case SIGN_IN_DECLINED:
      return {
        message: `You declined the sign-in to ${name}.`,
        hint: "Send a new message to sign in again.",
      };
    case "token_rejected_after_authorization":
      return {
        message: `The token from your sign-in to ${name} didn't work.`,
        hint: "Check the account you signed in with, then send a new message to try again.",
      };
    default:
      return isConnectionAuthorizationRequiredError(error)
        ? { message: `This agent has no credential for ${name}.` }
        : { message: `The sign-in to ${name} failed.` };
  }
}

function providerName(view: SessionView, { authorization, scope }: ModelSignIn): string {
  const connector = authorization?.vercelConnect?.connector.split("/").at(-1);
  return (
    authorization?.displayName ??
    askedDisplayName(view, scope) ??
    (connector === undefined ? undefined : displayProperName(connector)) ??
    "the service"
  );
}

/** The display name on the session's latest sign-in card for `scope`. */
function askedDisplayName(view: SessionView, scope: string): string | undefined {
  return Object.values(view.projection.view.interactions).findLast(
    (row) => row.request.signIn?.name === scope && row.request.signIn.displayName !== undefined,
  )?.request.signIn?.displayName;
}
