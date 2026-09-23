import type { FlexibleSchema, ModelMessage, ToolSet } from "ai";
import type { HarnessSession } from "#harness/types.js";

import { estimateTokens } from "#harness/token-estimate.js";
import { toModelSchema } from "#tools/schema.js";

/** Count only request content outside the durable model-visible history. */
export async function estimateRequestEnvelope(input: {
  readonly history: readonly ModelMessage[];
  readonly instructions: unknown;
  readonly messages: readonly ModelMessage[];
  readonly tools: ToolSet;
}): Promise<number> {
  const tools = await Promise.all(
    Object.entries(input.tools).map(async ([name, tool]) => {
      const inputSchema = await toolInputJsonSchema(tool.inputSchema);
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

async function toolInputJsonSchema(schema: FlexibleSchema | undefined): Promise<unknown> {
  if (schema === undefined) return undefined;
  const lowered = toModelSchema(schema, "input");
  const resolved: object = typeof lowered === "function" ? lowered() : lowered;
  return "jsonSchema" in resolved ? await resolved.jsonSchema : resolved;
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
