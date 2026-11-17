import {
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
} from "eve/connections";
import { mockModel } from "eve/evals";
import { interactions } from "eve/events";
import { defineModel, type DynamicModelContext } from "eve/models";

export const MODEL_SIGN_IN = "eve__model__fixture-model";
export const MODEL_TOKEN = "fixture-model-token-K2Q8";
export const FALLBACK_REPLY = "Answered on the project's credential.";

/**
 * Every turn starts without a credential, so every turn asks. The sign-in URL is the callback
 * itself with `code=fixture-ok`; an eval declines by swapping in `error=access_denied`.
 */
const auth = defineInteractiveAuthorization<{ marker: string }>({
  async getToken() {
    throw new ConnectionAuthorizationRequiredError("fixture-model");
  },
  async startAuthorization({ callbackUrl }) {
    const url = new URL(callbackUrl);
    url.searchParams.set("code", "fixture-ok");
    return {
      challenge: { displayName: "Fixture Model", url: url.href },
      resume: { marker: "fixture-resume" },
    };
  },
  async completeAuthorization({ callback, resume }) {
    if (callback.params.code !== "fixture-ok" || resume?.marker !== "fixture-resume") {
      throw new Error("Fixture authorization state mismatch.");
    }
    return { token: MODEL_TOKEN };
  },
});

/** Replies with the token `create` received, so an eval sees the credential reach the model. */
export const ownCredentialModel = defineModel({
  auth,
  authKey: "fixture-model",
  create: ({ token }) => mockModel(`Answered with ${token}.`),
  id: "fixture/own-credential",
});

/** The fallback after a decline: a model on the project's own credential. */
export const projectModel = mockModel(FALLBACK_REPLY);

/** Whether the person declined this turn's model sign-in. */
export function declinedModelSignIn(ctx: DynamicModelContext): boolean {
  return interactions(ctx.view).some(
    (asked) =>
      asked.turnId === ctx.turn?.id &&
      asked.request.signIn?.name === MODEL_SIGN_IN &&
      asked.outcome === "declined",
  );
}
