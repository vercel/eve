import { describe, expect, it } from "vitest";

import { prepareAuthoredWorkflowDirectives } from "./authored-workflow-directives.js";

const filePath = "/app/agent/tools/probe.ts";
const input = '{ key: "probe", target: "reviewer", message: "Review" }';

function prepare(source: string) {
  return prepareAuthoredWorkflowDirectives({ filePath, source });
}

describe("workflow helper callback contexts", () => {
  it.each([
    ['import { agent } from "eve/workflow";', `agent(ctx, ${input})`, "agent"],
    ['import { agent as delegate } from "eve/workflow";', `delegate(ctx, ${input})`, "agent"],
    ['import * as workflow from "eve/workflow";', `workflow.agent(ctx, ${input})`, "agent"],
    ['import * as workflow from "eve/workflow";', `workflow["agent"](ctx, ${input})`, "agent"],
    ['import { ask } from "eve/workflow";', 'ask(ctx, { prompt: "Continue?" })', "ask"],
  ])("rejects %s in an ordinary tool", async (binding, call, helper) => {
    await expect(
      prepare(`${binding}
import { defineTool } from "eve/tools";
export default defineTool({ async execute(input, ctx) { return ${call}; } });`),
    ).rejects.toThrow(new RegExp(`${filePath}:3:\\d+: ${helper}\\(\\)`));
  });

  it.each([
    [
      'import { defineChannel, POST } from "eve/channels";',
      'defineChannel({ routes: [POST("/probe", async (req, ctx) => CALL)] })',
    ],
    [
      'import { defineChannel } from "eve/channels";',
      'defineChannel({ events: { "message.completed": async (event, channel, ctx) => CALL } })',
    ],
    [
      'import { defineSchedule } from "eve/schedules";',
      'defineSchedule({ cron: "* * * * *", async run(ctx) { return CALL; } })',
    ],
    [
      'import { defineTool } from "eve/tools";',
      "defineTool({ execute: async () => 1, approval: async (input, ctx) => CALL })",
    ],
  ])("rejects helper calls in callbacks from %s", async (binding, definition) => {
    await expect(
      prepare(`import { agent } from "eve/workflow";
${binding}
export default ${definition.replace("CALL", `agent(ctx, ${input})`)};`),
    ).rejects.toThrow('agent() from "eve/workflow" requires the context of an eve workflow tool.');
  });

  it.each(["async function handler(req, ctx)", "const handler = async (req, ctx) =>"])(
    "checks a referenced route handler: %s",
    async (declaration) => {
      await expect(
        prepare(`import { agent } from "eve/workflow";
import { defineChannel as channel, POST } from "eve/channels";
export default channel({ routes: [POST("/probe", handler)] });
${declaration} { return agent(ctx, ${input}); }`),
      ).rejects.toThrow('agent() from "eve/workflow"');
    },
  );

  it.each([
    [
      'import { defineChannel, POST } from "eve/channels";',
      'defineChannel({ routes: [POST("/probe", handler)] })',
      "channel",
    ],
    [
      'import { defineSchedule } from "eve/schedules";',
      'defineSchedule({ cron: "* * * * *", run: handler })',
      "schedule",
    ],
  ])("rejects a workflow directive on %s callbacks", async (binding, definition, kind) => {
    await expect(
      prepare(`${binding}
export default ${definition};
async function handler() {
  "use workflow";
  return 1;
}`),
    ).rejects.toThrow(`"use workflow" is not supported on ${kind} callbacks`);
  });

  it("reports the same context requirement for a workflow channel that calls agent", async () => {
    await expect(
      prepare(`import { agent } from "eve/workflow";
import { defineChannel, POST } from "eve/channels";
export default defineChannel({ routes: [POST("/probe", async (req, ctx) => {
  "use workflow";
  return agent(ctx, ${input});
})] });`),
    ).rejects.toThrow('agent() from "eve/workflow" requires the context');
  });

  it("rejects calls in a step, including an exported shared helper", async () => {
    await expect(
      prepare(`import { agent } from "eve/workflow";
export async function step(ctx) {
  "use step";
  return agent(ctx, ${input});
}`),
    ).rejects.toThrow('agent() from "eve/workflow"');
  });

  it("checks plain object tool definitions", async () => {
    await expect(
      prepare(`import { agent } from "eve/workflow";
export default { description: "Probe", inputSchema: {}, async execute(input, ctx) { return agent(ctx, ${input}); } };`),
    ).rejects.toThrow('agent() from "eve/workflow"');
  });

  it("allows direct and nested callback calls in a workflow tool", async () => {
    await expect(
      prepare(`import { agent } from "eve/workflow";
import { defineTool } from "eve/tools";
export default defineTool({ async execute(input, ctx) {
  "use workflow";
  return Promise.all(input.items.map(() => agent(ctx, ${input})));
} });`),
    ).resolves.toMatchObject({ executeWorkflow: "execute" });
  });

  it("allows a referenced workflow execute and a shared helper without directives", async () => {
    await expect(
      prepare(`import { agent } from "eve/workflow";
import { defineTool } from "eve/tools";
export default defineTool({ execute });
async function execute(input, ctx) {
  "use workflow";
  return helper(ctx);
}
export async function helper(ctx) { return agent(ctx, ${input}); }`),
    ).resolves.toMatchObject({
      executeWorkflow: "execute",
    });
  });

  it("allows a shared helper next to an unrelated channel", async () => {
    await expect(
      prepare(`import { agent } from "eve/workflow";
import { defineChannel, POST } from "eve/channels";
export default defineChannel({ routes: [POST("/probe", async () => new Response())] });
export async function helper(ctx) { return agent(ctx, ${input}); }`),
    ).resolves.toMatchObject({
      hasDirectives: false,
    });
  });

  it.each([
    "async execute(input, ctx, agent) { return agent(ctx); }",
    "async execute(input, ctx) { const agent = input.run; return agent(ctx); }",
    "async execute({ agent }, ctx) { return agent(ctx); }",
    "async execute(input, ctx) { try {} catch (agent) { return agent(ctx); } }",
  ])("does not confuse a shadowed binding with the imported helper: %s", async (execute) => {
    await expect(
      prepare(`import { agent } from "eve/workflow";
import { defineTool } from "eve/tools";
export default defineTool({ ${execute} });`),
    ).resolves.toMatchObject({ hasDirectives: false });
  });

  it("does not reject similarly named imports, strings, or comments", async () => {
    await expect(
      prepare(`import { agent } from "other-package";
import { defineTool } from "eve/tools";
export default defineTool({ async execute(input, ctx) {
  // agent() from eve/workflow
  return agent(ctx, "eve/workflow");
} });`),
    ).resolves.toMatchObject({ hasDirectives: false });
  });

  it("respects shadowed helpers and definers in enclosing functions", async () => {
    await expect(
      prepare(`import { agent } from "eve/workflow";
import { defineTool } from "eve/tools";
export function localHelper(agent) {
  return defineTool({ execute: async (input, ctx) => agent(ctx) });
}
export function localDefiner(defineTool) {
  return defineTool({ execute: async (input, ctx) => agent(ctx) });
}`),
    ).resolves.toMatchObject({ hasDirectives: false });
  });

  it("does not resolve a callback parameter to a same-named top-level helper", async () => {
    await expect(
      prepare(`import { agent } from "eve/workflow";
import { defineChannel, POST } from "eve/channels";
export function makeChannel(handler) {
  return defineChannel({ routes: [POST("/probe", handler)] });
}
async function handler(ctx) { return agent(ctx, ${input}); }`),
    ).resolves.toMatchObject({ hasDirectives: false });
  });

  it("leaves handler factories to the runtime and compiled-definition checks", async () => {
    await expect(
      prepare(`import { defineChannel, POST } from "eve/channels";
import { start } from "#internal/workflow/runtime.js";
export default defineChannel({ routes: [POST("/probe", createHandler(job))] });
function createHandler(workflow) {
  return async () => { const run = await start(workflow, []); return new Response(run.runId); };
}
async function job() {
  "use workflow";
  return 1;
}`),
    ).resolves.toMatchObject({ hasWorkflowDirective: true });
  });

  it("does not classify a default helper object by an ancestor directory name", async () => {
    await expect(
      prepare(`import { agent } from "eve/workflow";
export default { async delegate(ctx) { return agent(ctx, ${input}); } };`),
    ).resolves.toMatchObject({ hasDirectives: false });
  });

  it("does not resolve a mutable callback binding to its initial function", async () => {
    await expect(
      prepare(`import { agent } from "eve/workflow";
import { defineChannel, POST } from "eve/channels";
let handler = async (ctx) => agent(ctx, ${input});
handler = async () => new Response();
export default defineChannel({ routes: [POST("/probe", handler)] });`),
    ).resolves.toMatchObject({ hasDirectives: false });
  });
});
