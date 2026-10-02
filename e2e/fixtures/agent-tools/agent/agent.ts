import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest } from "eve/evals";

import { readStripeColors, STRIPE_COUNT } from "./lib/stripes";

/** Stripe colors in the latest render-stripes image the prompt carries, if any. */
function promptStripeColors(request: MockModelRequest): string[] | undefined {
  const result = [...request.toolResults]
    .reverse()
    .find((entry) => entry.name === "render-stripes");
  if (!Array.isArray(result?.output)) return undefined;
  for (const part of result.output as { type?: string; data?: { data?: unknown } }[]) {
    if (part.type === "file" && typeof part.data?.data === "string") {
      return readStripeColors(Buffer.from(part.data.data, "base64"), STRIPE_COUNT);
    }
  }
  return undefined;
}

const base = e2eAgentConfig({
  mock(request) {
    if (request.userMessages.some((message) => message.includes("`render-stripes`"))) {
      const colors = promptStripeColors(request);
      if (colors !== undefined) return colors.join(", ");
      if (request.lastUserMessage?.includes("`render-stripes` exactly once")) {
        return { toolCalls: [{ name: "render-stripes", input: {} }] };
      }
      // Every later turn answers from the image replayed out of history.
      throw new Error("The render-stripes image is missing from the replayed prompt.");
    }
    if (request.lastUserMessage?.includes("`callback_identity`")) {
      const roles = request.messages.map((message) => message.role);
      if (roles.lastIndexOf("tool") <= roles.lastIndexOf("user")) {
        return { toolCalls: [{ name: "callback_identity", input: {} }] };
      }
      return "Callback identity checked.";
    }
    if (request.lastUserMessage?.includes("`context_messages`")) {
      const roles = request.messages.map((message) => message.role);
      if (roles.lastIndexOf("tool") <= roles.lastIndexOf("user")) {
        return { toolCalls: [{ name: "context_messages", input: {} }] };
      }
      return "Context messages checked.";
    }
    if (request.lastUserMessage?.includes("`no_reply`")) {
      const roles = request.messages.map((message) => message.role);
      if (roles.lastIndexOf("tool") <= roles.lastIndexOf("user")) {
        return {
          toolCalls: [{ name: "no_reply", input: { reason: "The note needs no answer." } }],
        };
      }
      // Reached only if `no_reply` failed to end the turn; the eval then sees a reply.
      return "Replied after no_reply.";
    }
    if (request.lastUserMessage?.includes("`react_to_note`")) {
      const roles = request.messages.map((message) => message.role);
      if (roles.lastIndexOf("tool") <= roles.lastIndexOf("user")) {
        const emoji = request.lastUserMessage.includes("rocket") ? "rocket" : "tada";
        return { toolCalls: [{ name: "react_to_note", input: { emoji } }] };
      }
      return "The rocket reaction isn't allowed in the team channel, so nothing was posted.";
    }
    if (request.lastUserMessage?.includes("`schema_validate`")) {
      const roles = request.messages.map((message) => message.role);
      if (roles.lastIndexOf("tool") <= roles.lastIndexOf("user")) {
        return {
          toolCalls: [
            {
              name: "schema_validate",
              input: {
                value: request.lastUserMessage?.includes("blank form") ? " " : "  normalized  ",
              },
            },
          ],
        };
      }
      const result = request.toolResults.at(-1);
      if (result?.name === "schema_validate" && result.isError) {
        return "Blank value rejected.";
      }
      return "Schema validation checked.";
    }
    return `Mock reply: ${request.lastUserMessage ?? ""}`;
  },
});

export default defineAgent({
  ...base,
  experimental: {
    ...base.experimental,
    workflow: {
      ...base.experimental?.workflow,
      modelCallsPerStep: 3,
    },
  },
  reasoning: "high",
});
