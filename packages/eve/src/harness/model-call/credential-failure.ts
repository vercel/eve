import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
import { stopForSignIn } from "#harness/hitl/index.js";
import { SIGN_IN_DECLINED } from "#harness/hitl/sign-ins.js";
import type { SessionView } from "#harness/session-machine/view.js";
import { failTurn, type Step } from "#harness/step/context.js";
import type { StepResult } from "#harness/types.js";
import { displayProperName } from "#protocol/session-projection/display-name.js";
import {
  handleAuthorizationError,
  type ScopedAuthorization,
  type ScopedAuthorizationRequiredError,
} from "#runtime/connections/scoped-authorization.js";
import { supportsInteractiveAuthorization } from "#shared/connection-types.js";
import {
  credentialFailureCode,
  type ModelCredentialFailureCode,
  refusesCredential,
} from "./errors.js";

export async function pauseForModelSignIn(
  step: Step,
  required: ScopedAuthorizationRequiredError,
  beforePause?: () => Promise<void>,
): Promise<StepResult> {
  if (!supportsInteractiveAuthorization(required.scoped.authorization)) {
    return await failModelCredential(
      step,
      "MODEL_AUTHORIZATION_FAILED",
      required.cause,
      required.scoped,
    );
  }
  let signIn: Awaited<ReturnType<typeof handleAuthorizationError>>;
  try {
    signIn = await handleAuthorizationError(required, { evictToken: false });
  } catch (error) {
    return await failModelCredential(step, credentialFailureCode(error), error, required.scoped);
  }
  await beforePause?.();
  return await stopForSignIn(step, signIn);
}

export async function failModelCredential(
  step: Step,
  code: ModelCredentialFailureCode,
  error: unknown,
  scoped: ScopedAuthorization,
): Promise<StepResult> {
  const name = providerName(step.view(), scoped);
  return await failTurn(step, error, code, credentialFailureMessage(code, name, error));
}

function credentialFailureMessage(
  code: ModelCredentialFailureCode,
  name: string,
  error: unknown,
): string {
  switch (code) {
    case "MODEL_AUTHORIZATION_FAILED":
      return signInFailureMessage(name, error);
    case "MODEL_CREATE_FAILED":
      return `eve couldn't build the model from the ${name} credential.`;
    case "MODEL_CREDENTIAL_FAILED":
      return `eve couldn't get the ${name} credential.`;
  }
}

function signInFailureMessage(name: string, error: unknown): string {
  if (!isConnectionAuthorizationFailedError(error)) {
    return refusesCredential(error)
      ? `${name} rejected the credential.`
      : `The turn got no ${name} credential.`;
  }
  switch (error.reason) {
    case SIGN_IN_DECLINED:
    case "sign_in_cancelled":
      return `The ${name} sign-in ended without a credential.`;
    case "sign_in_unavailable":
      return `A scheduled turn can't ask for the ${name} sign-in.`;
    case "principal_required":
      return `The ${name} credential needs a signed-in user.`;
    case "token_rejected_after_authorization":
      return `${name} rejected the credential from the sign-in.`;
    case "app_not_installed":
    case "authorization_callback_unavailable":
      return `The turn got no ${name} credential.`;
    default:
      return `${name}: ${error.message}`;
  }
}

function providerName(view: SessionView, signIn: ScopedAuthorization): string {
  const cards = Object.values(view.projection.view.interactions).flatMap(
    (row) => row.request.signIn ?? [],
  );
  const card = cards.findLast((asked) => asked.name === signIn.scope);
  return signIn.authorization.displayName ?? card?.displayName ?? displayProperName(signIn.scope);
}
