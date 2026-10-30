import { e2eAgentConfig } from "@eve-e2e/config";
import { CALL_TOOL, SEARCH_TOOL } from "@eve-e2e/config/catalog-tools";
import {
  callTool,
  outputOf,
  playScript,
  resultOf,
  type ScriptedCall,
} from "@eve-e2e/config/mock-script";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

/** Whether eve announced `name` in its catalog listing. */
function announced({ messages }: MockModelRequest, name: string): boolean {
  return messages.some(
    (message) => message.role === "user" && message.text.includes(`- ${name}: `),
  );
}

const BISCUIT_VISIT = {
  petId: 4217,
  visit: { kind: "grooming", date: "2026-10-14" },
  contacts: [{ name: "Alice", phone: "555-0100" }],
};

const KENNEL_CALLS: readonly ScriptedCall[] = [
  callTool("kennel-find", "kennel__find_pet", { name: "Biscuit" }),
  callTool("kennel-feedings", "kennel__list_feedings", { petId: 4217 }),
  callTool("kennel-photo", "kennel__pet_photo", { petId: 4217 }),
  callTool("kennel-discharge", "kennel__discharge_pet", { petId: 4217 }),
  callTool("kennel-bad-input", "kennel__book_visit", { petId: "4217", visit: { kind: "bath" } }),
  callTool("kennel-unknown", "kennel__find_pets"),
  {
    id: "kennel-book",
    // Corrects the misshapen booking from the signature its error returned.
    input: (request) => ({
      input: outputOf(request, "kennel-bad-input").includes("Signature: kennel__book_visit(")
        ? BISCUIT_VISIT
        : {},
      name: "kennel__book_visit",
    }),
    name: CALL_TOOL,
  },
];

/** Calls each kennel tool, then reports the photo's image parts and the suggested name. */
function kennelResponse(request: MockModelRequest): MockModelResponse | string {
  return playScript(request, KENNEL_CALLS, (finished) => {
    const photo = resultOf(finished, "kennel-photo")?.output;
    const imageParts = Array.isArray(photo)
      ? photo.filter((part) => JSON.stringify(part).includes('"image/png"')).length
      : 0;
    const suggested = outputOf(finished, "kennel-unknown").includes(
      "Closest tools: kennel__find_pet",
    );
    return `KENNEL_MCP_DONE photo-image-parts=${imageParts} suggestion=${suggested ? "yes" : "no"}`;
  });
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
          input: () => ({ query: "dynamic-catalog__" }),
          name: SEARCH_TOOL,
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
          input: () => ({ query: "petstore__" }),
          name: SEARCH_TOOL,
        },
        callTool("petstore-inventory", "petstore__getInventory", {}),
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
      [callTool("approval-inventory", "petstore-approval__getInventory")],
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
