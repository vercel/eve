import { describe, expect, it } from "vitest";

import type { ConnectionToolMetadata } from "#shared/connection-types.js";

import { closestToolNames, rankConnectionTools } from "./connection-search-rank.js";

function tool(
  name: string,
  description: string,
  properties: Record<string, { readonly description?: string }> = {},
): ConnectionToolMetadata {
  return { name, description, inputSchema: { type: "object", properties } };
}

const linear = { connectionName: "linear", description: "Issues, projects, and teams." };
const github = { connectionName: "github", description: "Repositories and pull requests." };
const kennel = { connectionName: "kennel", description: "Boarding pets and visits." };

const candidates = [
  { connection: linear, tool: tool("list_issues", "List open issues.", { teamId: {} }) },
  { connection: linear, tool: tool("get_team", "Get a team by id.") },
  { connection: github, tool: tool("search_repositories", "Find repos by keyword.") },
  {
    connection: kennel,
    tool: tool("book_visit", "Book a care visit.", {
      contacts: { description: "People to notify about the visit." },
    }),
  },
];

const rank = (query: string) =>
  rankConnectionTools(query, candidates).map(
    ({ connection, tool }) => `${connection.connectionName}/${tool.name}`,
  );

describe("rankConnectionTools", () => {
  it.each([
    { query: "linear", expected: ["linear/get_team", "linear/list_issues"] },
    { query: "people", expected: ["kennel/book_visit"] },
    // The tool named for issues outranks one matched only by its connection's description.
    { query: "issues", expected: ["linear/list_issues", "linear/get_team"] },
    { query: "repo", expected: ["github/search_repositories"] },
    { query: "isue", expected: [] },
    {
      query: "",
      expected: [
        "github/search_repositories",
        "kennel/book_visit",
        "linear/get_team",
        "linear/list_issues",
      ],
    },
  ])("ranks $query", ({ query, expected }) => {
    expect(rank(query)).toEqual(expected);
  });
});

describe("closestToolNames", () => {
  it("suggests from the tools' own fields, not the shared connection", () => {
    const tools = [tool("find_pet", "Look up a pet."), tool("list_feedings", "Feeding schedule.")];
    expect(closestToolNames("kennel_find_pets", tools, 5)).toEqual(["find_pet"]);
  });
});
