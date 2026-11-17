import type { EveLanguageModel } from "#shared/agent-definition.js";
import type { AuthorizationDefinition, TokenResult } from "#shared/connection-types.js";
import {
  assertAuthKey,
  normalizeAuthorizationSpec,
  sanitizeScopeSegment,
} from "#shared/validate-authorization.js";

const MODEL_DEFINITION: unique symbol = Symbol.for("eve.model-definition");
const MODEL_SIGN_IN_PREFIX = "eve__model__";

const defined = new Map<string, ModelDefinition>();

/**
 * A model that runs on the caller's own credential. eve resolves `auth` before each model call,
 * opens the same sign-in as a connection when the caller has none, and passes the credential to
 * `create`. Every field that sets a session's turn model accepts it; `compaction.model` and the
 * decision model of `auto()` reject it.
 */
export interface ModelDefinition {
  /**
   * The model ID eve reports on `model.started` and as `ctx.model.id`, and looks up in the AI
   * Gateway model catalog for the context window. For an ID outside the catalog, set
   * `modelContextWindowTokens` where you select the model.
   */
  readonly id: string;
  /**
   * The credential strategy, in the shapes a connection's `auth` accepts: `connect(...)` from
   * `@vercel/connect/eve`, `defineInteractiveAuthorization(...)`, or `{ getToken }`.
   */
  readonly auth: AuthorizationDefinition;
  /**
   * Keys the credential for the sign-in, the token cache, and the rule against asking twice in a
   * turn. Required when `auth` has no Vercel Connect connector. Definitions with one key share
   * one sign-in and one token.
   */
  readonly authKey?: string;
  /** Builds the provider model from the credential. Synchronous: I/O belongs in `auth.getToken`. */
  readonly create: (credential: TokenResult) => EveLanguageModel;
}

/**
 * Defines a model that runs on the caller's own credential, for an agent's `model`, a dynamic
 * model's result, or an `auto()` or `agent({ models })` option.
 *
 * ```ts
 * import { createAnthropic } from "@ai-sdk/anthropic";
 * import { connect } from "@vercel/connect/eve";
 * import { defineModel } from "eve/models";
 *
 * export const ownClaude = defineModel({
 *   id: "anthropic/claude-sonnet-5",
 *   auth: connect("anthropic/myagent"),
 *   create: ({ token }) => createAnthropic({ apiKey: token })("claude-sonnet-5"),
 * });
 * ```
 */
export function defineModel(definition: ModelDefinition): ModelDefinition {
  if (typeof definition.id !== "string" || definition.id.trim() === "") {
    throw new Error('defineModel: The "id" field must be a non-empty string.');
  }
  if (typeof definition.create !== "function") {
    throw new Error('defineModel: The "create" field must be a function of the credential.');
  }
  const auth = normalizeAuthorizationSpec(definition.auth, "defineModel:", "auth");
  const authKey =
    definition.authKey === undefined
      ? undefined
      : assertAuthKey(definition.authKey, 'defineModel: The "authKey" field');
  if (authKey === undefined && auth.vercelConnect === undefined) {
    throw new Error(
      'defineModel: Set "authKey" to key the credential: "auth" has no Vercel Connect connector.',
    );
  }
  const model: ModelDefinition = {
    auth,
    ...(authKey !== undefined && { authKey }),
    create: definition.create,
    id: definition.id,
  };
  Object.defineProperty(model, MODEL_DEFINITION, { value: true });
  defined.set(modelSignInName(model), model);
  return model;
}

export function isModelDefinition(value: unknown): value is ModelDefinition {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, MODEL_DEFINITION) === true
  );
}

export function modelSignInName(definition: ModelDefinition): string {
  return `${MODEL_SIGN_IN_PREFIX}${definition.authKey ?? sanitizeScopeSegment(definition.auth.vercelConnect!.connector)}`;
}

export function definedModel(signInName: string): ModelDefinition | undefined {
  return defined.get(signInName);
}
