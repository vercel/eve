import { asSchema, TypeValidationError } from "ai";
import { observeToolOutput } from "#tool-stubs/execute.js";

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import {
  authorizationPendingModelText,
  isAuthorizationPendingModelOutput,
} from "#harness/authorization.js";
import { resolveToolCallInputObject } from "#harness/coordination.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { normalizeToolModelOutput, type ToolModelOutputValue } from "#harness/tool-model-output.js";
import { toErrorMessage } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";
import type { JsonObject } from "#shared/json.js";
import { toModelSchema } from "#tools/schema.js";

export type ToolCallInputCheck =
  | { readonly kind: "valid"; readonly value: JsonObject }
  | {
      readonly kind: "invalid";
      readonly issues: readonly StandardSchemaV1.Issue[];
      readonly message: string;
    }
  | { readonly kind: "threw"; readonly error: unknown };

export async function checkToolCallInput(
  definition: Pick<HarnessToolDefinition, "inputSchema" | "name">,
  input: unknown,
  callId: string,
): Promise<ToolCallInputCheck> {
  let value: JsonObject;
  try {
    value = resolveToolCallInputObject(input, { callId, toolName: definition.name });
  } catch (error) {
    return invalidInput(definition.name, error);
  }
  let result: Awaited<ReturnType<NonNullable<ReturnType<typeof asSchema>["validate"]>>>;
  try {
    const schema = asSchema(toModelSchema(definition.inputSchema, "input"));
    if (schema.validate === undefined) return { kind: "valid", value };
    result = await schema.validate(value);
  } catch (error) {
    return { error, kind: "threw" };
  }
  return result.success
    ? { kind: "valid", value: result.value as JsonObject }
    : invalidInput(definition.name, result.error);
}

function invalidInput(toolName: string, error: unknown): ToolCallInputCheck {
  return {
    issues: schemaIssues(error),
    kind: "invalid",
    message: `Invalid input for tool "${toolName}": ${toErrorMessage(error)}`,
  };
}

function schemaIssues(error: unknown): readonly StandardSchemaV1.Issue[] {
  const cause = TypeValidationError.isInstance(error) ? error.cause : undefined;
  return Array.isArray(cause) && cause.every(isIssue)
    ? cause
    : [{ message: toErrorMessage(error) }];
}

function isIssue(value: unknown): value is StandardSchemaV1.Issue {
  return isObject(value) && typeof value.message === "string";
}

export async function toolCallModelOutput(
  definition: Pick<HarnessToolDefinition, "name" | "toModelOutput">,
  output: unknown,
  toolCallId: string | undefined,
): Promise<ToolModelOutputValue> {
  return await observeToolOutput(
    definition.name,
    toolCallId === undefined ? [] : [{ callId: toolCallId }],
    async () => {
      if (isAuthorizationPendingModelOutput(output)) {
        return { type: "text", value: authorizationPendingModelText(output.connections) };
      }
      if (definition.toModelOutput !== undefined) {
        return normalizeToolModelOutput({
          output: await definition.toModelOutput(output),
          toolCallId,
          toolName: definition.name,
        });
      }
      if (typeof output === "string") return { type: "text", value: output };
      return normalizeToolModelOutput({
        output: { type: "json", value: output ?? null },
        toolCallId,
        toolName: definition.name,
      });
    },
  );
}
