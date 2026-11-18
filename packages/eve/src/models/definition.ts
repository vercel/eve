import type { EveLanguageModel } from "#shared/agent-definition.js";
import type { AuthorizationDefinition, TokenResult } from "#shared/connection-types.js";
import {
  assertAuthKey,
  normalizeAuthorizationSpec,
  sanitizeScopeSegment,
} from "#shared/validate-authorization.js";

const MODEL_DEFINITION: unique symbol = Symbol.for("eve.model-definition");
const MODEL_SIGN_IN_PREFIX = "eve__model__";

/**
 * A model with a connection-style `auth`. eve resolves `auth` before each model call with a
 * connection's principal rules, opens the same sign-in as a connection when the caller has none,
 * and passes the credential to `create`. Every field that sets a session's turn model accepts it; `compaction.model`, the
 * decision model of `auto()`, `ctx.agent()`'s `model`, and a dynamic subagent's config reject it.
 */
export interface ModelDefinition {
  /**
   * Identifies the model. eve reports it on `model.started` and as `ctx.model.id`, and looks it up
   * in the AI Gateway model catalog for the context window. For an ID outside the catalog, set
   * `modelContextWindowTokens` in the selection.
   */
  readonly id: string;
  /**
   * The credential strategy: `connect(...)` from `@vercel/connect/eve`,
   * `defineInteractiveAuthorization(...)`, or `{ getToken }`, as on a connection.
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
 * Defines a model with a connection-style `auth`, for an agent's `model`, a dynamic
 * model's result, or an `auto()` or `agent({ models })` option.
 *
 * ```ts
 * import { connect } from "@vercel/connect/eve";
 * import { createGateway } from "ai";
 * import { defineModel } from "eve/models";
 *
 * export const ownGateway = defineModel({
 *   id: "anthropic/claude-sonnet-5",
 *   auth: connect("vercel/myagent"),
 *   create: ({ token }) =>
 *     createGateway({ apiKey: token, teamIdOrSlug: "acme" })("anthropic/claude-sonnet-5"),
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
  return model;
}

export function isModelDefinition(value: unknown): value is ModelDefinition {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, MODEL_DEFINITION) === true
  );
}

export function isModelSignInName(name: string): boolean {
  return name.startsWith(MODEL_SIGN_IN_PREFIX);
}

export function modelSignInName(definition: ModelDefinition): string {
  return `${MODEL_SIGN_IN_PREFIX}${definition.authKey ?? sanitizeScopeSegment(definition.auth.vercelConnect!.connector)}`;
}
