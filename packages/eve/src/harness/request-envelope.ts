import type { ModelMessage, ToolSet } from "ai";
import type { HarnessSession } from "#harness/types.js";

import { serializeInputSchema, type ToolSchemaSource } from "#tools/schema.js";
import { estimateTokens } from "#harness/token-estimate.js";

/** Count only request content outside the durable model-visible history. */
export async function estimateRequestEnvelope(input: {
  readonly history: readonly ModelMessage[];
  readonly instructions: unknown;
  readonly messages: readonly ModelMessage[];
  readonly tools: ToolSet;
}): Promise<number> {
  const tools = await Promise.all(
    Object.entries(input.tools).map(async ([name, tool]) => {
      const schema = typeof tool.inputSchema === "function" ? tool.inputSchema() : tool.inputSchema;
      const inputSchema =
        schema === undefined
          ? undefined
          : "jsonSchema" in schema
            ? await schema.jsonSchema
            : serializeInputSchema(schema as ToolSchemaSource);
      return {
        name,
        description: tool.description,
        inputSchema,
        id: tool.type === "provider" ? tool.id : undefined,
        args: tool.type === "provider" ? tool.args : undefined,
      };
    }),
  );
  return Math.max(
    0,
    estimateTokens({ instructions: input.instructions, messages: input.messages, tools }) -
      estimateTokens(input.history),
  );
}

const REQUEST_ENVELOPE_STATE_KEY = "eve.harness.requestEnvelopeTokens";

export function getRequestEnvelopeTokens(session: HarnessSession): number | undefined {
  const value = session.state?.[REQUEST_ENVELOPE_STATE_KEY];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function setRequestEnvelopeTokens(
  session: HarnessSession,
  tokens: number | undefined,
): HarnessSession {
  if (tokens === undefined && session.state?.[REQUEST_ENVELOPE_STATE_KEY] === undefined)
    return session;
  const state = { ...session.state };
  if (tokens === undefined) delete state[REQUEST_ENVELOPE_STATE_KEY];
  else state[REQUEST_ENVELOPE_STATE_KEY] = tokens;
  return { ...session, state };
}
