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

/** The result of checking one tool call's input the way a model-issued call is checked. */
export type ToolCallInputCheck =
  | { readonly kind: "valid"; readonly value: JsonObject }
  | {
      readonly kind: "invalid";
      /** What is wrong with the input, for a caller that reports it in its own words. */
      readonly issues: readonly StandardSchemaV1.Issue[];
      readonly message: string;
    }
  | { readonly kind: "threw"; readonly error: unknown };

/**
 * Checks a tool call's input the way a conversation does: no input (or an
 * empty string) is `{}`, anything else that is not a JSON object is
 * rejected, and the rest must satisfy the schema the model was given.
 */
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
    // The schema the model sees; normalizing a malformed one throws like a validator.
    const schema = asSchema(toModelSchema(definition.inputSchema, "input"));
    if (schema.validate === undefined) return { kind: "valid", value };
    result = await schema.validate(value);
  } catch (error) {
    // A validator that throws failed itself; its message is not a diagnostic of the input.
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

/** The schema's own issues; any other failure is reported as one issue. */
function schemaIssues(error: unknown): readonly StandardSchemaV1.Issue[] {
  const cause = TypeValidationError.isInstance(error) ? error.cause : undefined;
  return Array.isArray(cause) && cause.every(isIssue)
    ? cause
    : [{ message: toErrorMessage(error) }];
}

function isIssue(value: unknown): value is StandardSchemaV1.Issue {
  return isObject(value) && typeof value.message === "string";
}

/**
 * What the model sees for a tool's output: pending sign-in text, the
 * author's `toModelOutput`, or the output as text or JSON.
 */
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
