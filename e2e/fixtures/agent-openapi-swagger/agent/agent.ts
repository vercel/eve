import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

/** Whether eve announced `name` in its connection listing. */
function announced({ messages }: MockModelRequest, name: string): boolean {
  return messages.some(
    (message) => message.role === "user" && message.text.includes(`- ${name}: `),
  );
}

const kennelCall = (id: string, tool: string, input: Record<string, unknown>) => ({
  id,
  input: { connection: "kennel", tool, input },
  name: "connection_execute",
});

const BISCUIT_VISIT = {
  petId: 4217,
  visit: { kind: "grooming", date: "2026-10-14" },
  contacts: [{ name: "Alice", phone: "555-0100" }],
};

/** Walks every kennel result shape, retrying the misshapen call from its signature. */
function kennelResponse({ toolResults }: MockModelRequest): MockModelResponse | string {
  const byId = new Map(toolResults.map((result) => [result.id, result]));
  if (!byId.has("kennel-bad-input")) {
    return {
      toolCalls: [
        kennelCall("kennel-find", "find_pet", { name: "Biscuit" }),
        kennelCall("kennel-feedings", "list_feedings", { petId: 4217 }),
        kennelCall("kennel-photo", "pet_photo", { petId: 4217 }),
        kennelCall("kennel-discharge", "discharge_pet", { petId: 4217 }),
        kennelCall("kennel-bad-input", "book_visit", {
          petId: "4217",
          visit: { kind: "bath" },
        }),
        kennelCall("kennel-unknown", "find_pets", { name: "Biscuit" }),
      ],
    };
  }
  if (!byId.has("kennel-book")) {
    const error = byId.get("kennel-bad-input");
    return error?.isError === true && JSON.stringify(error.output).includes("book_visit(input:")
      ? { toolCalls: [kennelCall("kennel-book", "book_visit", BISCUIT_VISIT)] }
      : "KENNEL_SIGNATURE_MISSING";
  }
  const photo = byId.get("kennel-photo")?.output;
  const imageParts = Array.isArray(photo)
    ? photo.filter((part) => JSON.stringify(part).includes('"image/png"')).length
    : 0;
  return `KENNEL_MCP_DONE photo-image-parts=${imageParts}`;
}

const config = e2eAgentConfig({
  mock: (request) => {
    const { lastUserMessage, toolResults } = request;
    if (lastUserMessage?.includes("KENNEL_MCP_E2E")) return kennelResponse(request);
    if (lastUserMessage?.includes("DYNAMIC_MCP_CONNECTION_E2E")) {
      return announced(request, "dynamic-mcp")
        ? "DYNAMIC_MCP_CONNECTION_FOUND"
        : "DYNAMIC_MCP_CONNECTION_MISSING";
    }
    if (lastUserMessage?.includes("PETSTORE_EXECUTE_E2E")) {
      const result = toolResults.find((entry) => entry.name === "connection_execute");
      if (result === undefined) {
        return {
          toolCalls: [
            {
              id: "petstore-inventory",
              input: { connection: "petstore", tool: "getInventory", input: {} },
              name: "connection_execute",
            },
          ],
        };
      }
      return result.isError ? "inventory failed" : "inventory received";
    }
    if (!lastUserMessage?.includes("DYNAMIC_CONNECTION_E2E")) {
      return `Mock reply: ${lastUserMessage ?? ""}`;
    }
    if (toolResults.some((result) => result.name === "connection_search")) {
      return "DYNAMIC_CONNECTION_FOUND";
    }
    if (announced(request, "dynamic-catalog")) {
      return {
        toolCalls: [
          {
            id: "dynamic-connection-search",
            input: { connection: "dynamic-catalog", query: "status" },
            name: "connection_search",
          },
        ],
      };
    }
    return "DYNAMIC_CONNECTION_MISSING";
  },
});

export default defineAgent({
  ...config,
  // Measure Anthropic cache reuse through its native provider (see connection-cache.eval.ts).
  ...(typeof config.model === "string" && config.model.startsWith("anthropic/")
    ? { modelOptions: { providerOptions: { gateway: { only: ["anthropic"] } } } }
    : {}),
  reasoning: "high",
});
