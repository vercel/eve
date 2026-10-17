import { describe, expect, expectTypeOf, it } from "vitest";
import type { DynamicResolveContext } from "#dynamic/definition.js";
import { defineDynamic as tools } from "#public/definitions/dynamic-tools.js";
import { defineDynamic as skills } from "#public/definitions/dynamic-skills.js";
import { defineSkill } from "#public/definitions/skill.js";
import { defineTool } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

const context: DynamicResolveContext = {
  model: null,
  messages: [],
  channel: { kind: "http", metadata: {} },
  session: { id: "session", auth: { current: null, initiator: null } },
};

describe("slot-typed dynamic authoring", () => {
  it("infers the change-point fact and constrains tool returns", async () => {
    const tool = defineTool({
      description: "Read a status",
      inputSchema: defineJsonSchema({ type: "object" }),
      execute: () => "ready",
    });
    const resolver = tools({
      events: {
        beforeSession(event) {
          expectTypeOf(event.type).toEqualTypeOf<"session.started">();
          return tool;
        },
      },
    });
    expect(
      await resolver.events.beforeSession?.({ type: "session.started", data: {} }, context),
    ).toBe(tool);
    tools({
      events: {
        // @ts-expect-error Tool resolvers cannot return arbitrary data.
        beforeSession: () => ({ broken: true }),
      },
    });
  });

  it("accepts skills but excludes model boundaries from skill handlers", async () => {
    const skill = defineSkill({ description: "Review a summary", markdown: "Read the summary." });
    const resolver = skills({
      events: {
        beforeTurn(event) {
          expectTypeOf(event.type).toEqualTypeOf<"turn.started">();
          return skill;
        },
      },
    });
    expect(
      await resolver.events.beforeTurn?.(
        {
          type: "turn.started",
          data: { turnId: "turn", cause: { deliveryId: "delivery" }, follows: null },
        },
        context,
      ),
    ).toBe(skill);
    skills({
      events: {
        // @ts-expect-error Skills remain stable within a turn.
        beforeModel: () => skill,
      },
    });
  });
});
