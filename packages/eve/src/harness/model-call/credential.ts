import type { LanguageModelV4 } from "@ai-sdk/provider";
import { type LanguageModel, wrapLanguageModel } from "ai";

import { isMockModel } from "#internal/mock-model-identity.js";
import { isModelDefinition, type ModelDefinition, modelSignInName } from "#models/definition.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { resolveMockAuthoredRuntimeModel } from "#runtime/agent/mock-model-adapter.js";
import type { RuntimeModel } from "#runtime/agent/resolve-model.js";
import {
  createAuthorizationExecution,
  evictScopedToken,
  type ScopedAuthorization,
} from "#runtime/connections/scoped-authorization.js";
import type { TokenResult } from "#shared/connection-types.js";
import { rejectsCredential } from "./errors.js";

export async function credentialedModel(
  model: RuntimeModel,
  reference: RuntimeModelReference,
): Promise<LanguageModel> {
  if (!isModelDefinition(model)) return model;
  const execution = createAuthorizationExecution();
  const scoped = scopedAuthorization(model);
  const create = async () => createdModel(model, await execution.getToken(scoped), reference);
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

function createdModel(
  definition: ModelDefinition,
  credential: TokenResult,
  reference: RuntimeModelReference,
): LanguageModelV4 {
  const created = definition.create(credential);
  const model = isMockModel(created)
    ? created
    : (resolveMockAuthoredRuntimeModel(reference) ?? created);
  return wrapLanguageModel({ middleware: {}, model: model as Exclude<LanguageModel, string> });
}
