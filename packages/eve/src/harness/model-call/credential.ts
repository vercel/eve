import type { LanguageModelV4 } from "@ai-sdk/provider";
import { type LanguageModel, wrapLanguageModel } from "ai";

import { isModelDefinition, type ModelDefinition, modelSignInName } from "#models/definition.js";
import type { RuntimeModel } from "#runtime/agent/resolve-model.js";
import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
import {
  createAuthorizationExecution,
  evictScopedToken,
  isScopedAuthorizationRequiredError,
  type ScopedAuthorization,
} from "#runtime/connections/scoped-authorization.js";
import type { TokenResult } from "#shared/connection-types.js";
import { isRuntimeLanguageModel } from "#internal/runtime-model.js";
import { ModelCredentialFailure, rejectsCredential } from "./errors.js";

export async function credentialedModel(model: RuntimeModel): Promise<LanguageModel> {
  if (!isModelDefinition(model)) return model;
  const execution = createAuthorizationExecution();
  const scoped = scopedAuthorization(model);
  const create = async () => createdModel(model, await credentialFor(execution, scoped), scoped);
  let current = await create();
  const withCredential = async <T>(run: (model: LanguageModelV4) => PromiseLike<T>): Promise<T> => {
    try {
      return await run(current);
    } catch (error) {
      if (!rejectsCredential(error)) throw error;
      await evictScopedToken(scoped);
      current = await create();
      try {
        return await run(current);
      } catch (again) {
        if (!rejectsCredential(again)) throw again;
        await evictScopedToken(scoped);
        return execution.requireAuth(scoped, again);
      }
    }
  };
  return wrapLanguageModel({
    middleware: {
      wrapGenerate: ({ params }) => withCredential((model) => model.doGenerate(params)),
      wrapStream: ({ params }) => withCredential((model) => model.doStream(params)),
    },
    model: current,
  });
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
    const code = isConnectionAuthorizationFailedError(error)
      ? "MODEL_AUTHORIZATION_FAILED"
      : "MODEL_CREDENTIAL_FAILED";
    throw new ModelCredentialFailure(code, scoped, error);
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
