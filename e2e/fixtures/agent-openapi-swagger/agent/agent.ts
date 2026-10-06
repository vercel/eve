import { e2eAgentConfig } from "@eve-e2e/config";
import { outputOf, playScript, type ScriptedCall } from "@eve-e2e/config/mock-script";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

/** Whether eve announced `name` in its catalog listing. */
function announced({ messages }: MockModelRequest, name: string): boolean {
  return messages.some(
    (message) => message.role === "user" && message.text.includes(`- ${name}: `),
  );
}

/** A connection tool call through `execute`, with a fixed id so the script knows when it ran. */
const execute = (id: string, tool: string, input?: Record<string, unknown>): ScriptedCall => ({
  id,
  input: () => (input === undefined ? { tool } : { input, tool }),
  name: "execute",
});

const BISCUIT_VISIT = {
  petId: 4217,
  visit: { kind: "grooming", date: "2026-10-14" },
  contacts: [{ name: "Alice", phone: "555-0100" }],
};

/** Calls every kennel tool at once, then corrects the misshapen booking from its signature. */
function kennelResponse(request: MockModelRequest): MockModelResponse | string {
  const done = new Set(request.toolResults.map((result) => result.id));
  if (!done.has("kennel-find")) {
    return {
      toolCalls: [
        {
          id: "kennel-find",
          name: "execute",
          input: { tool: "kennel__find_pet", input: { name: "Biscuit" } },
        },
        {
          id: "kennel-feedings",
          name: "execute",
          input: { tool: "kennel__list_feedings", input: { petId: 4217 } },
        },
        {
          id: "kennel-photo",
          name: "execute",
          input: { tool: "kennel__pet_photo", input: { petId: 4217 } },
        },
        {
          id: "kennel-discharge",
          name: "execute",
          input: { tool: "kennel__discharge_pet", input: { petId: 4217 } },
        },
        {
          id: "kennel-bad-input",
          name: "execute",
          input: { tool: "kennel__book_visit", input: { petId: "4217", visit: { kind: "bath" } } },
        },
        { id: "kennel-unknown", name: "execute", input: { tool: "kennel__find_pets" } },
      ],
    };
  }
  if (!done.has("kennel-book")) {
    return outputOf(request, "kennel-bad-input").includes("kennel__book_visit(input:")
      ? {
          toolCalls: [
            {
              id: "kennel-book",
              name: "execute",
              input: { tool: "kennel__book_visit", input: BISCUIT_VISIT },
            },
          ],
        }
      : "KENNEL_SIGNATURE_MISSING";
  }
  const photo = request.toolResults.find((result) => result.id === "kennel-photo")?.output;
  const imageParts = Array.isArray(photo)
    ? photo.filter((part) => JSON.stringify(part).includes('"image/png"')).length
    : 0;
  const suggested = outputOf(request, "kennel-unknown").includes("Closest tools: kennel__find_pet");
  return `KENNEL_MCP_DONE photo-image-parts=${imageParts} suggestion=${suggested ? "yes" : "no"}`;
}

function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  if (message.includes("DYNAMIC_MCP_CONNECTION_E2E")) {
    return announced(request, "dynamic-mcp")
      ? "DYNAMIC_MCP_CONNECTION_FOUND"
      : "DYNAMIC_MCP_CONNECTION_MISSING";
  }
  if (message.includes("DYNAMIC_CONNECTION_E2E")) {
    if (!announced(request, "dynamic-catalog")) return "DYNAMIC_CONNECTION_MISSING";
    return playScript(
      request,
      [
        {
          id: "dynamic-search",
          input: () => ({ connection: "dynamic-catalog", query: "status" }),
          name: "search",
        },
      ],
      (finished) =>
        outputOf(finished, "dynamic-search").includes('"tool":"dynamic-catalog__getStatus"')
          ? "DYNAMIC_CONNECTION_FOUND"
          : "DYNAMIC_CONNECTION_MISSING",
    );
  }
  if (message.includes("PETSTORE_EXECUTE_E2E")) {
    return playScript(
      request,
      [
        {
          id: "petstore-search",
          input: () => ({ connection: "petstore", query: "inventory" }),
          name: "search",
        },
        execute("petstore-inventory", "petstore__getInventory", {}),
      ],
      (finished) =>
        outputOf(finished, "petstore-inventory").includes('"available":7')
          ? "inventory received"
          : "inventory failed",
    );
  }
  if (message.includes("PETSTORE_APPROVAL_E2E")) {
    return playScript(
      request,
      [execute("approval-inventory", "petstore-approval__getInventory")],
      (finished) =>
        outputOf(finished, "approval-inventory").includes('"available":7')
          ? "inventory received"
          : "inventory failed",
    );
  }
  if (message.includes("KENNEL_MCP_E2E")) return kennelResponse(request);
  return `Mock reply: ${message}`;
}

export default defineAgent({
  ...e2eAgentConfig({ mock: respond }),
  reasoning: "high",
});
