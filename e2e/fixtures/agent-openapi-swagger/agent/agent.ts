import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";

  if (message.includes("DYNAMIC_MCP_CONNECTION_E2E")) {
    const search = request.tools.find((tool) => tool.name === "connection_search");
    return search?.description?.includes("dynamic-mcp")
      ? "DYNAMIC_MCP_CONNECTION_FOUND"
      : "DYNAMIC_MCP_CONNECTION_MISSING";
  }

  if (message.includes("DYNAMIC_CONNECTION_E2E")) {
    if (request.toolResults.some((result) => result.name === "connection_search")) {
      return "DYNAMIC_CONNECTION_FOUND";
    }
    return {
      toolCalls: [
        {
          id: "dynamic-connection-search",
          input: { connection: "dynamic-catalog", keywords: "status", limit: 10 },
          name: "connection_search",
        },
      ],
    };
  }

  const approvalConnection = message.includes("petstore-approval");
  const inventoryTool = approvalConnection
    ? "petstore-approval__getInventory"
    : "petstore__getInventory";
  if (message.includes("inventory") || message.includes("getInventory")) {
    if (request.toolResults.some((result) => result.name === inventoryTool)) {
      return "inventory received";
    }
    if (!request.toolResults.some((result) => result.name === "connection_search")) {
      return {
        toolCalls: [
          {
            id: approvalConnection ? "approval-search" : "petstore-search",
            input: {
              connection: approvalConnection ? "petstore-approval" : "petstore",
              keywords: "inventory operation",
              limit: 10,
            },
            name: "connection_search",
          },
        ],
      };
    }
    return {
      toolCalls: [
        {
          id: approvalConnection ? "approval-inventory" : "petstore-inventory",
          input: {},
          name: inventoryTool,
        },
      ],
    };
  }

  return `Mock reply: ${message}`;
}

const base = e2eAgentConfig();

export default defineAgent({
  ...base,
  model: mockModel(respond),
  modelContextWindowTokens: base.modelContextWindowTokens ?? 1_000_000,
  reasoning: "high",
});
