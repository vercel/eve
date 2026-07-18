import { describe, expect, it } from "vitest";

import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import {
  createCompactionConfig,
  createSession,
  DEFAULT_ROOT_MAX_INPUT_TOKENS_PER_SESSION,
  hydrateDurableSession,
  mintSubagentContinuationToken,
  projectToDurableSession,
  refreshSessionFromTurnAgent,
} from "#execution/session.js";

function createTestTurnAgent(overrides?: Partial<RuntimeTurnAgent>): RuntimeTurnAgent {
  return {
    id: "test-agent",
    instructions: ["You are a helpful assistant.", "Be concise."],
    compactionModel: {
      id: "summary-model",
    },
    model: { id: "test-model" },
    tools: [
      {
        description: "Adds two numbers",
        inputSchema: {
          properties: { a: { type: "number" }, b: { type: "number" } },
          type: "object",
        },
        kind: "authored-tool",
        logicalPath: "tools/add",
        name: "add",
        sourceId: "src-add",
      },
    ],
    workspaceSpec: { rootEntries: [] },
    ...overrides,
  };
}

describe("createCompactionConfig", () => {
  it("derives the threshold from the model context window", () => {
    expect(
      createCompactionConfig({
        contextWindowTokens: 200_000,
      }),
    ).toEqual({
      recentWindowSize: 10,
      threshold: 180_000,
    });
  });

  it("uses the authored threshold percent when provided", () => {
    expect(
      createCompactionConfig({
        contextWindowTokens: 200_000,
        thresholdPercent: 0.5,
      }),
    ).toEqual({
      recentWindowSize: 10,
      threshold: 100_000,
    });
  });

  it("falls back to the static threshold when the model has no context window", () => {
    expect(createCompactionConfig()).toEqual({
      recentWindowSize: 10,
      threshold: 100_000,
    });
  });
});

describe("createSession", () => {
  it("creates a session with correct agent configuration", () => {
    const outputSchema = { properties: { title: { type: "string" } }, type: "object" } as const;
    const session = createSession({
      continuationToken: "root-token",
      outputSchema,
      sessionId: "sess-root",
      turnAgent: createTestTurnAgent({ outputSchema, reasoning: "high" }),
    });

    expect(session.agent.compactionModelReference).toEqual({ id: "summary-model" });
    expect(session.agent.modelReference).toEqual({ id: "test-model" });
    expect(session.agent.reasoning).toBe("high");
    expect(session.outputSchema).toEqual(outputSchema);
    expect(session.agent.system).toBe("You are a helpful assistant.\n\nBe concise.");
    expect(session.agent.tools).toEqual([
      {
        description: "Adds two numbers",
        inputSchema: {
          properties: { a: { type: "number" }, b: { type: "number" } },
          type: "object",
        },
        name: "add",
      },
    ]);
  });

  it("renders available skill paths with the chosen skill root", () => {
    const session = createSession({
      continuationToken: "root-token",
      sessionId: "sess-root",
      skillRoot: "/home/agent/.agents/skills",
      turnAgent: createTestTurnAgent({
        availableSkills: [{ description: "Research topics.", name: "research" }],
      }),
    });

    expect(session.agent.system).toContain(
      "Skill files live under `/home/agent/.agents/skills/<skill>/`.",
    );
    expect(session.agent.system).toContain(
      "- research: Research topics. (path: /home/agent/.agents/skills/research/SKILL.md)",
    );
    expect(session.agent.system).not.toContain("/workspace/skills");
    expect(session.agent.system).not.toContain("fallback");
  });

  it("starts with empty history and stores the continuation token verbatim", () => {
    const session = createSession({
      continuationToken: "root-token",
      sessionId: "sess-root",
      turnAgent: createTestTurnAgent(),
    });

    expect(session.history).toEqual([]);
    expect(session.continuationToken).toBe("root-token");
  });

  it("defaults description and inputSchema when null", () => {
    const session = createSession({
      continuationToken: "root-token",
      sessionId: "sess-root",
      turnAgent: createTestTurnAgent({
        tools: [
          {
            description: "",
            inputSchema: null,
            kind: "authored-tool",
            logicalPath: "tools/noop",
            name: "noop",
            sourceId: "src-noop",
          },
        ],
      }),
    });

    expect(session.agent.tools[0]).toEqual({
      description: "",
      inputSchema: null,
      name: "noop",
    });
  });

  it("sets default compaction config when no overrides are provided", () => {
    const session = createSession({
      continuationToken: "root-token",
      sessionId: "sess-root",
      turnAgent: createTestTurnAgent(),
    });

    expect(session.compaction).toEqual({
      recentWindowSize: 10,
      threshold: 100_000,
    });
  });

  it("honors compactionOverrides.thresholdPercent", () => {
    const session = createSession({
      compactionOverrides: { thresholdPercent: 0.5 },
      continuationToken: "root-token",
      sessionId: "sess-root",
      turnAgent: createTestTurnAgent({
        model: { id: "test-model", contextWindowTokens: 200_000 },
      }),
    });

    expect(session.compaction).toEqual({
      recentWindowSize: 10,
      threshold: 100_000,
    });
  });

  it("copies the compaction model into the refreshed session", () => {
    const session = createSession({
      continuationToken: "root-token",
      sessionId: "sess-root",
      turnAgent: createTestTurnAgent(),
    });

    const refreshed = refreshSessionFromTurnAgent({
      session,
      turnAgent: createTestTurnAgent({
        compactionModel: {
          id: "updated-summary-model",
        },
      }),
    });

    expect(refreshed.agent.compactionModelReference).toEqual({
      id: "updated-summary-model",
    });
  });

  it("defaults root sessions to the root input token budget", () => {
    const session = createSession({
      continuationToken: "root-token",
      sessionId: "sess-root",
      turnAgent: createTestTurnAgent(),
    });

    expect(session.limits?.maxInputTokensPerSession).toBe(
      DEFAULT_ROOT_MAX_INPUT_TOKENS_PER_SESSION,
    );
  });

  it("leaves delegated subagent sessions uncapped by default", () => {
    const session = createSession({
      continuationToken: "subagent-token",
      sessionId: "sess-child",
      subagentDepth: 1,
      turnAgent: createTestTurnAgent(),
    });

    expect(session.limits).toEqual({});
  });

  it("uncaps a root session when the authored limit is false", () => {
    const session = createSession({
      continuationToken: "root-token",
      limits: { maxInputTokensPerSession: false },
      sessionId: "sess-root",
      turnAgent: createTestTurnAgent(),
    });

    expect(session.limits).toEqual({});
  });

  it("uncaps a delegated subagent session when the authored limit is false", () => {
    const session = createSession({
      continuationToken: "subagent-token",
      limits: { maxInputTokensPerSession: false },
      sessionId: "sess-child",
      subagentDepth: 1,
      turnAgent: createTestTurnAgent(),
    });

    expect(session.limits).toEqual({});
  });

  it("treats a durable session without stored limits as uncapped on hydration", () => {
    const hydrated = hydrateDurableSession({
      durable: {
        agent: { system: "You are a helpful assistant." },
        continuationToken: "root-token",
        history: [],
        sessionId: "sess-root",
      },
      turnAgent: createTestTurnAgent(),
    });

    expect(hydrated.limits).toBeUndefined();
  });

  it("rehydrates persisted limits verbatim without re-applying defaults", () => {
    const hydrated = hydrateDurableSession({
      durable: {
        agent: { system: "You are a helpful assistant." },
        continuationToken: "subagent-token",
        history: [],
        limits: {},
        sessionId: "sess-child",
        subagentDepth: 1,
      },
      turnAgent: createTestTurnAgent(),
    });

    // An uncapped session (resolved limits `{}`) must stay uncapped across
    // rehydration instead of picking up the root default again.
    expect(hydrated.limits).toEqual({});
  });

  it("persists run outputSchema through durable session projection and hydration", () => {
    const agentOutputSchema = {
      properties: { ignored: { type: "string" } },
      required: ["ignored"],
      type: "object",
    } as const;
    const runOutputSchema = {
      properties: { title: { type: "string" } },
      required: ["title"],
      type: "object",
    } as const;
    const session = createSession({
      continuationToken: "root-token",
      outputSchema: runOutputSchema,
      sessionId: "sess-root",
      turnAgent: createTestTurnAgent({ outputSchema: agentOutputSchema }),
    });

    const durable = projectToDurableSession(session);
    const hydrated = hydrateDurableSession({
      durable,
      turnAgent: createTestTurnAgent({ outputSchema: agentOutputSchema }),
    });

    expect(durable.outputSchema).toEqual(runOutputSchema);
    expect(hydrated.outputSchema).toEqual(runOutputSchema);
  });

  it("persists subagent depth through durable session projection and hydration", () => {
    const session = createSession({
      continuationToken: "root-token",
      sessionId: "sess-root",
      subagentDepth: 2,
      turnAgent: createTestTurnAgent(),
    });

    const durable = projectToDurableSession(session);
    const hydrated = hydrateDurableSession({
      durable,
      turnAgent: createTestTurnAgent(),
    });

    expect(durable.subagentDepth).toBe(2);
    expect(hydrated.subagentDepth).toBe(2);
  });

  it("persists session token limits through durable session projection and hydration", () => {
    const session = createSession({
      continuationToken: "root-token",
      limits: {
        maxInputTokensPerSession: 200_000,
        maxOutputTokensPerSession: 20_000,
      },
      sessionId: "sess-root",
      turnAgent: createTestTurnAgent(),
    });

    const durable = projectToDurableSession(session);
    const hydrated = hydrateDurableSession({
      durable,
      turnAgent: createTestTurnAgent(),
    });

    expect(durable.limits).toEqual({
      maxInputTokensPerSession: 200_000,
      maxOutputTokensPerSession: 20_000,
    });
    expect(hydrated.limits).toEqual({
      maxInputTokensPerSession: 200_000,
      maxOutputTokensPerSession: 20_000,
    });
  });

  it("restores current reasoning configuration when hydrating a durable session", () => {
    const session = createSession({
      continuationToken: "root-token",
      sessionId: "sess-root",
      turnAgent: createTestTurnAgent({ reasoning: "low" }),
    });

    const durable = projectToDurableSession(session);
    const hydrated = hydrateDurableSession({
      durable,
      turnAgent: createTestTurnAgent({ reasoning: "high" }),
    });

    expect(durable.agent).toEqual({ system: session.agent.system });
    expect(hydrated.agent.reasoning).toBe("high");
  });
});

describe("mintSubagentContinuationToken", () => {
  it("prefixes the token with 'subagent:'", () => {
    expect(mintSubagentContinuationToken()).toMatch(/^subagent:/);
  });

  it("returns a unique token on each call", () => {
    const a = mintSubagentContinuationToken();
    const b = mintSubagentContinuationToken();
    expect(a).not.toBe(b);
  });
});

describe("refreshSessionFromTurnAgent", () => {
  it("refreshes the current agent configuration while preserving history", () => {
    const session = createSession({
      continuationToken: "root-token",
      sessionId: "sess-root",
      turnAgent: createTestTurnAgent(),
    });
    const refreshed = refreshSessionFromTurnAgent({
      session: {
        ...session,
        history: [{ content: "previous message", role: "user" }],
      },
      turnAgent: createTestTurnAgent({
        instructions: ["Completely different system prompt."],
        model: { contextWindowTokens: 200_000, id: "updated-model" },
        tools: [
          {
            description: "Echoes text",
            inputSchema: {
              properties: { text: { type: "string" } },
              type: "object",
            },
            kind: "authored-tool",
            logicalPath: "tools/echo",
            name: "echo",
            sourceId: "src-echo",
          },
        ],
      }),
    });

    expect(refreshed.history).toEqual([{ content: "previous message", role: "user" }]);
    expect(refreshed.agent.compactionModelReference).toEqual({
      id: "summary-model",
    });
    expect(refreshed.agent.modelReference).toEqual({
      contextWindowTokens: 200_000,
      id: "updated-model",
    });
    expect(refreshed.agent.system).toBe("Completely different system prompt.");
    expect(refreshed.agent.tools).toEqual([
      {
        description: "Echoes text",
        inputSchema: {
          properties: {
            text: {
              type: "string",
            },
          },
          type: "object",
        },
        name: "echo",
      },
    ]);
    expect(refreshed.compaction.threshold).toBe(180_000);
  });

  it("preserves last known compaction counters when refreshing compaction", () => {
    const session = createSession({
      continuationToken: "root-token",
      sessionId: "sess-root",
      turnAgent: createTestTurnAgent({
        model: { contextWindowTokens: 100_000, id: "initial-model" },
      }),
    });
    const refreshed = refreshSessionFromTurnAgent({
      compactionOverrides: {
        thresholdPercent: 0.5,
      },
      session: {
        ...session,
        compaction: {
          ...session.compaction,
          lastKnownInputTokens: 321,
          lastKnownPromptMessageCount: 7,
        },
      },
      turnAgent: createTestTurnAgent({
        model: { contextWindowTokens: 200_000, id: "updated-model" },
      }),
    });

    expect(refreshed.compaction).toEqual({
      lastKnownInputTokens: 321,
      lastKnownPromptMessageCount: 7,
      recentWindowSize: 10,
      threshold: 100_000,
    });
  });

  it("refreshes the system prompt when turnAgent instructions differ", () => {
    const session = createSession({
      continuationToken: "root-token",
      sessionId: "sess-root",
      turnAgent: createTestTurnAgent({
        instructions: ["Original session-start prompt."],
      }),
    });
    const refreshed = refreshSessionFromTurnAgent({
      session,
      turnAgent: createTestTurnAgent({
        instructions: ["Updated prompt from the current deployment."],
        model: { contextWindowTokens: 200_000, id: "updated-model" },
      }),
    });

    expect(refreshed.agent.modelReference).toEqual({
      contextWindowTokens: 200_000,
      id: "updated-model",
    });
    expect(refreshed.agent.system).toBe("Updated prompt from the current deployment.");
  });

  it("refreshes available skill paths with the chosen skill root", () => {
    const session = createSession({
      continuationToken: "root-token",
      sessionId: "sess-root",
      turnAgent: createTestTurnAgent({
        availableSkills: [{ description: "Research topics.", name: "research" }],
      }),
    });
    const refreshed = refreshSessionFromTurnAgent({
      session,
      skillRoot: "/workspace/skills",
      turnAgent: createTestTurnAgent({
        availableSkills: [{ description: "Research topics.", name: "research" }],
      }),
    });

    expect(refreshed.agent.system).toContain(
      "Skill files live under `/workspace/skills/<skill>/`.",
    );
    expect(refreshed.agent.system).toContain(
      "- research: Research topics. (path: /workspace/skills/research/SKILL.md)",
    );
    expect(refreshed.agent.system).not.toContain("$HOME");
    expect(refreshed.agent.system).not.toContain("fallback");
  });
});
