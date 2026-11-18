import type { LanguageModelV4 } from "@ai-sdk/provider";
import { type LanguageModel, wrapLanguageModel } from "ai";

import { isModelDefinition, type ModelDefinition, modelSignInName } from "#models/definition.js";
import type { RuntimeModel } from "#runtime/agent/resolve-model.js";
import {
  createAuthorizationExecution,
  evictScopedToken,
  isScopedAuthorizationRequiredError,
  type ScopedAuthorization,
} from "#runtime/connections/scoped-authorization.js";
import type { TokenResult } from "#shared/connection-types.js";
import { isRuntimeLanguageModel } from "#internal/runtime-model.js";
import { credentialFailureCode, ModelCredentialFailure } from "./errors.js";

export interface CredentialedModel {
  readonly model: LanguageModel;
  readonly renew?: (rejection: unknown) => Promise<void>;
}

export async function credentialedModel(model: RuntimeModel): Promise<CredentialedModel> {
  if (!isModelDefinition(model)) return { model };
  const execution = createAuthorizationExecution();
  const scoped = scopedAuthorization(model);
  const create = async () => createdModel(model, await credentialFor(execution, scoped), scoped);
  let current = await create();
  let renewed = false;
  return {
    model: wrapLanguageModel({
      middleware: {
        wrapGenerate: ({ params }) => current.doGenerate(params),
        wrapStream: ({ params }) => current.doStream(params),
      },
      model: current,
    }),
    async renew(rejection) {
      await evictScopedToken(scoped);
      if (renewed) execution.requireAuth(scoped, rejection);
      renewed = true;
      current = await create();
    },
  };
}

function scopedAuthorization(definition: ModelDefinition): ScopedAuthorization {
  return {
    authorization: definition.auth,
    connection: { url: "" },
    scope: modelSignInName(definition),
  };
}

async function credentialFor(
  execution: ReturnType<typeof createAuthorizationExecution>,
  scoped: ScopedAuthorization,
): Promise<TokenResult> {
  try {
    return await execution.getToken(scoped);
  } catch (error) {
    if (isScopedAuthorizationRequiredError(error)) throw error;
    throw new ModelCredentialFailure(credentialFailureCode(error), scoped, error);
  }
}

function createdModel(
  definition: ModelDefinition,
  credential: TokenResult,
  scoped: ScopedAuthorization,
): LanguageModelV4 {
  try {
    const created: unknown = definition.create(credential);
    if (!isRuntimeLanguageModel(created)) throw new Error("create returned no language model.");
    return wrapLanguageModel({ middleware: {}, model: created as Exclude<LanguageModel, string> });
  } catch (error) {
    throw new ModelCredentialFailure("MODEL_CREATE_FAILED", scoped, error);
  }
}
