import { asSchema } from "ai";

import {
  authorizationPendingModelText,
  isAuthorizationPendingModelOutput,
} from "#harness/authorization.js";
import { resolveToolCallInputObject } from "#harness/coordination.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { isRemoteInputPendingOutput, remoteInputPendingModelText } from "#harness/remote-input.js";
import { normalizeToolModelOutput, type ToolModelOutputValue } from "#harness/tool-model-output.js";
import { toErrorMessage } from "#shared/errors.js";
import type { JsonObject } from "#shared/json.js";
import { toModelSchema } from "#tools/schema.js";

/** The result of checking one tool call's input the way a model-issued call is checked. */
export type ToolCallInputCheck =
  | { readonly kind: "valid"; readonly value: JsonObject }
  | { readonly kind: "invalid"; readonly message: string }
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
    return {
      kind: "invalid",
      message: `Invalid input for tool "${definition.name}": ${toErrorMessage(error)}`,
    };
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
    : {
        kind: "invalid",
        message: `Invalid input for tool "${definition.name}": ${toErrorMessage(result.error)}`,
      };
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
  if (isAuthorizationPendingModelOutput(output)) {
    return { type: "text", value: authorizationPendingModelText(output.connections) };
  }
  if (isRemoteInputPendingOutput(output)) {
    return { type: "text", value: remoteInputPendingModelText(output.connection) };
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
}
