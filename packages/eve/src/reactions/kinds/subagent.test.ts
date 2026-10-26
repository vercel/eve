import { describe, expect, it } from "vitest";

import { StaticModelReferenceKey } from "#context/keys.js";
import {
  beforeModelCall,
  evaluationError,
  reactionSession,
} from "#internal/testing/reaction-session.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineRemoteAgent } from "#public/definitions/remote-agent.js";
import { buildDynamicSubagentTools, readDynamicSubagentSelections } from "./subagent.js";

const analyst = (description = "Analyzes the books.") =>
  defineAgent({ description, model: "openai/gpt-5.4" });

describe("dynamic subagents", () => {
  it("offers a returned agent as a tool, and omits one whose function returns null", async () => {
    const { ctx } = reactionSession({
      subagents: [
        { evaluate: () => analyst(), name: "analyst" },
        { evaluate: () => null, name: "auditor" },
      ],
    });
    await beforeModelCall(ctx);

    expect(buildDynamicSubagentTools(ctx).map(({ name }) => name)).toEqual(["analyst"]);
    expect(Object.keys(readDynamicSubagentSelections(ctx))).toEqual(["subagents/analyst"]);
  });

  it("keeps a tool: false agent selectable without offering it to the model", async () => {
    const { ctx } = reactionSession({
      subagents: [{ evaluate: () => analyst(), name: "analyst", tool: false }],
    });
    await beforeModelCall(ctx);

    expect(buildDynamicSubagentTools(ctx)).toEqual([]);
    expect(readDynamicSubagentSelections(ctx)["subagents/analyst"]?.kind).toBe("subagent");
  });

  it("selects a remote agent with the URL it returns", async () => {
    const { ctx } = reactionSession({
      subagents: [
        {
          evaluate: () =>
            defineRemoteAgent({ description: "Finance.", url: "https://finance.example" }),
          name: "finance",
        },
      ],
    });
    await beforeModelCall(ctx);

    expect(readDynamicSubagentSelections(ctx)["subagents/finance"]).toMatchObject({
      kind: "remote",
      remoteAgent: { url: "https://finance.example" },
    });
  });

  it("reads the model the session chose", async () => {
    const seen: string[] = [];
    const { ctx } = reactionSession({
      subagents: [
        {
          evaluate: (ctx) => {
            seen.push(ctx.model.id);
            return null;
          },
          name: "analyst",
        },
      ],
    });
    ctx.set(StaticModelReferenceKey, { id: "openai/gpt-5.4" } as never);
    await beforeModelCall(ctx);

    expect(seen).toEqual(["openai/gpt-5.4"]);
  });

  it.each([
    ["an authored tool's name", { toolNames: ["analyst"] }, 'collides with the tool "analyst"'],
    ["eve's namespace", { name: "eve" }, 'uses the reserved name "eve"'],
  ])("rejects %s", async (_name, input, message) => {
    const { name = "analyst", ...session } = input as { name?: string; toolNames?: string[] };
    const { ctx } = reactionSession({
      ...session,
      subagents: [{ evaluate: () => analyst(), name }],
    });
    expect(await evaluationError(ctx)).toContain(message);
  });

  it("points packaging configuration at the root agent", async () => {
    const { ctx } = reactionSession({
      subagents: [
        {
          evaluate: () => ({ ...analyst(), build: { externalDependencies: ["duckdb"] } }),
          name: "analyst",
        },
      ],
    });
    expect(await evaluationError(ctx)).toContain(
      "Declare packaging configuration such as build.externalDependencies on the root agent",
    );
  });
});
