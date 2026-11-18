import type { LanguageModelV4 } from "@ai-sdk/provider";
import { type LanguageModel, wrapLanguageModel } from "ai";

import { isMockModel } from "#internal/mock-model-identity.js";
import { isModelDefinition, type ModelDefinition, modelSignInName } from "#models/definition.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { resolveMockAuthoredRuntimeModel } from "#runtime/agent/mock-model-adapter.js";
import type { RuntimeModel } from "#runtime/agent/resolve-model.js";
import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
import {
  createAuthorizationExecution,
  evictScopedToken,
  isScopedAuthorizationRequiredError,
  type ScopedAuthorization,
} from "#runtime/connections/scoped-authorization.js";
import type { EveLanguageModel } from "#shared/agent-definition.js";
import type { TokenResult } from "#shared/connection-types.js";
import { toErrorMessage } from "#shared/errors.js";
import { rejectsCredential } from "./errors.js";

export async function credentialedModel(
  model: RuntimeModel,
  reference: RuntimeModelReference,
): Promise<LanguageModel> {
  if (!isModelDefinition(model)) return model;
  const execution = createAuthorizationExecution();
  const scoped = scopedAuthorization(model);
  const create = async () => createdModel(model, await credentialFor(execution, scoped), reference);
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

class ModelCredentialError extends Error {
  readonly connectionName: string;

  constructor(connectionName: string, cause: unknown) {
    super(`Resolving the "${connectionName}" credential failed.`, { cause });
    this.name = "ModelCredentialError";
    this.connectionName = connectionName;
  }
}

class ModelCreateError extends Error {
  readonly modelId: string;

  constructor(modelId: string, cause: unknown) {
    super(`Building the "${modelId}" model failed: ${toErrorMessage(cause)}`, { cause });
    this.name = "ModelCreateError";
    this.modelId = modelId;
  }
}

export function isModelCredentialError(error: unknown): error is ModelCredentialError {
  return error instanceof Error && error.name === "ModelCredentialError";
}

export function isModelCreateError(error: unknown): error is ModelCreateError {
  return error instanceof Error && error.name === "ModelCreateError";
}

async function credentialFor(
  execution: ReturnType<typeof createAuthorizationExecution>,
  scoped: ScopedAuthorization,
): Promise<TokenResult> {
  try {
    return await execution.getToken(scoped);
  } catch (error) {
    if (isScopedAuthorizationRequiredError(error) || isConnectionAuthorizationFailedError(error))
      throw error;
    throw new ModelCredentialError(scoped.scope, error);
  }
}

function createdModel(
  definition: ModelDefinition,
  credential: TokenResult,
  reference: RuntimeModelReference,
): LanguageModelV4 {
  let created: EveLanguageModel;
  try {
    created = definition.create(credential);
  } catch (error) {
    throw new ModelCreateError(definition.id, error);
  }
  const model = isMockModel(created)
    ? created
    : (resolveMockAuthoredRuntimeModel(reference) ?? created);
  return wrapLanguageModel({ middleware: {}, model: model as Exclude<LanguageModel, string> });
}
