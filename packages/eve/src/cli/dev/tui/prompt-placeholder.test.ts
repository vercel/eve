import { describe, expect, it } from "vitest";

import type { AgentInfoResult } from "#client/index.js";
import { createTestAgentInfoResult } from "#internal/testing/agent-info-fixture.js";
import { AGENT_INSTRUCTIONS_TEMPLATE } from "#setup/scaffold/create/instructions-template.js";
import { initialPromptPlaceholder } from "./prompt-placeholder.js";

function scaffold(): AgentInfoResult {
  const info = createTestAgentInfoResult();
  const source = {
    logicalPath: "instructions.md",
    sourceId: "instructions.md",
    sourceKind: "markdown" as const,
    owner: { kind: "application" as const },
  };
  return {
    ...info,
    instructions: {
      dynamic: [],
      static: [
        { ...source, name: "instructions", role: "system", content: AGENT_INSTRUCTIONS_TEMPLATE },
      ],
    },
    channels: {
      shadowed: [],
      routes: [
        {
          ...info.agent.config,
          logicalPath: "channels/eve.ts",
          name: "eve",
          method: "POST",
          urlPath: "/eve/v1/session",
        },
        {
          ...info.agent.config,
          logicalPath: "channels/eve.ts",
          name: "eve",
          method: "POST",
          urlPath: "/.well-known/workflow/v1/webhook/:token",
        },
      ],
    },
    subagents: {
      total: 1,
      local: [
        {
          ...info.agent.config,
          owner: { kind: "extension", namespace: "self-modification", packageName: "eve" },
          name: "self-modification__agent",
          entryPath: "subagents/agent/agent.ts",
          rootPath: "/eve/self-modification",
          nodeId: "self-modification__agent",
          parentNodeId: "__root__",
          summary: {
            channels: 0,
            connections: 0,
            hooks: 0,
            instructions: 1,
            memories: 0,
            schedules: 0,
            skills: 1,
            tools: 3,
          },
        },
      ],
    },
  };
}

describe("initialPromptPlaceholder", () => {
  it("invites scaffold customization despite the default eve channel and development capabilities", () => {
    const info = scaffold();
    expect(
      initialPromptPlaceholder(
        {
          ...info,
          skills: {
            dynamic: [],
            static: [
              {
                ...info.subagents.local[0]!,
                name: "self-modification__trace_analysis",
                description: "Inspect traces",
                markdown: "Inspect traces",
              },
            ],
          },
        },
        true,
      ),
    ).toBe("Ask me to connect a channel, edit instructions, add a tool…");
  });

  it.each(["instructions", "tool", "extension", "dynamic tool"])(
    "suggests a channel after customizing %s",
    (change) => {
      const info = scaffold();
      const tool = {
        ...info.agent.config,
        logicalPath: "tools/quote.ts",
        name: "quote",
        description: "Quote an order",
        hasAuth: false,
        hasExecute: true,
        hasModelOutputProjection: false,
        hasOutputSchema: false,
        inputSchema: {},
        requiresApproval: false,
      };
      const customized: AgentInfoResult =
        change === "instructions"
          ? {
              ...info,
              instructions: {
                dynamic: [],
                static: [
                  { ...info.instructions.static[0]!, content: "Help Alice prepare orders." },
                ],
              },
            }
          : change === "dynamic tool"
            ? {
                ...info,
                tools: {
                  static: [],
                  dynamic: [
                    {
                      ...info.agent.config,
                      logicalPath: "tools/quote.ts",
                      slug: "quote",
                      eventNames: ["turn.started"],
                    },
                  ],
                },
              }
            : {
                ...info,
                tools: {
                  dynamic: [],
                  static: [
                    {
                      ...tool,
                      ...(change === "extension"
                        ? {
                            owner: {
                              kind: "extension" as const,
                              packageName: "@acme/orders",
                              namespace: "orders",
                            },
                          }
                        : {}),
                    },
                  ],
                },
              };
      expect(initialPromptPlaceholder(customized, true)).toBe(
        "Send a message, or ask me to add a channel…",
      );
    },
  );

  it("stays neutral once an integration channel exists", () => {
    const info = scaffold();
    expect(
      initialPromptPlaceholder(
        {
          ...info,
          channels: {
            ...info.channels,
            routes: [
              ...info.channels.routes,
              {
                ...info.agent.config,
                logicalPath: "channels/slack.ts",
                name: "slack",
                method: "POST",
                urlPath: "/slack",
              },
            ],
          },
        },
        true,
      ),
    ).toBe("Send a message…");
  });

  it.each([
    "remote",
    "production",
    "missing info",
    "no self-modification",
    "discovery error",
    "missing instructions",
    "dynamic instructions",
  ])("stays neutral with %s", (condition) => {
    const info = scaffold();
    const uncertain =
      condition === "missing info"
        ? undefined
        : condition === "production"
          ? { ...info, mode: "production" as const }
          : condition === "no self-modification"
            ? { ...info, subagents: { local: [], total: 0 } }
            : condition === "discovery error"
              ? { ...info, diagnostics: { discoveryErrors: 1, discoveryWarnings: 0 } }
              : condition === "missing instructions"
                ? { ...info, instructions: { static: [], dynamic: [] } }
                : condition === "dynamic instructions"
                  ? {
                      ...info,
                      instructions: {
                        static: [],
                        dynamic: [
                          {
                            ...info.agent.config,
                            slug: "instructions",
                            eventNames: ["turn.started"],
                          },
                        ],
                      },
                    }
                  : info;
    expect(initialPromptPlaceholder(uncertain, condition !== "remote")).toBe("Send a message…");
  });
});
