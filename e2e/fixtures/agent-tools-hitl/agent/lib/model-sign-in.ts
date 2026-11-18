import {
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
} from "eve/connections";
import { latestTaskResult, playScript } from "@eve-e2e/config/mock-script";
import { mockModel } from "eve/evals";
import { interactions } from "eve/events";
import { defineModel, type DynamicModelContext } from "eve/models";

export const MODEL_SIGN_IN = "eve__model__fixture-model";
export const MODEL_TOKEN = "fixture-model-token-K2Q8";
/** `projectModel`'s reply. The `fallback-after-decline` eval checks it to tell which model replied. */
export const PROJECT_MODEL_REPLY = "Answered on the project's credential.";

/**
 * The fixture stores no token, so `getToken` throws and eve opens a sign-in on every turn: each
 * eval starts from a missing credential. The sign-in URL is the callback URL with
 * `code=fixture-ok`, so an eval completes the sign-in with one GET, and declines it by swapping in
 * `error=access_denied`.
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

/** Replies with its credential's token, so an eval sees the credential reach the model. */
export const ownCredentialModel = defineModel({
  auth,
  authKey: "fixture-model",
  create: ({ token }) => mockModel(`Answered with ${token}.`),
  id: "fixture/own-credential",
});

/** The model a dynamic `model` falls back to after a decline, on the project's own credential. */
export const projectModel = mockModel(PROJECT_MODEL_REPLY);

/** Delegates to `own-credential-child`, waits for it, and reports its answer. */
export const delegatingModel = mockModel((request) =>
  playScript(
    request,
    [
      {
        id: "delegate",
        input: () => ({ message: "Answer Alice's question." }),
        name: "own-credential-child",
      },
      { id: "wait", name: "eve__task_wait" },
    ],
    (finished) =>
      `Child answered: ${latestTaskResult(finished, "own-credential-child") ?? "nothing"}`,
  ),
);

/** Whether the person declined this turn's model sign-in. */
export function declinedModelSignIn(ctx: DynamicModelContext): boolean {
  return interactions(ctx.view).some(
    (asked) =>
      asked.turnId === ctx.turn?.id &&
      asked.request.signIn?.name === MODEL_SIGN_IN &&
      asked.outcome === "declined",
  );
}
