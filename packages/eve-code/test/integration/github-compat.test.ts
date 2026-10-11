import assert from "node:assert/strict";
import test from "node:test";
import type { SkillDefinition } from "eve/skills";

import extension from "../../extension/extension.ts";
import instructions from "../../extension/instructions/github.ts";
import pr from "../../extension/skills/pr.ts";
import gh from "../../extension/tools/gh.ts";

const context = {
  model: null,
  session: { id: "github-compat-test", auth: { current: null, initiator: null } },
  channel: {},
  messages: [],
};

async function resolve() {
  const instructionHandler = instructions.events["session.started"];
  const skillHandler = pr.events["session.started"];
  const toolHandler = gh.events["session.started"];
  assert.ok(instructionHandler && skillHandler && toolHandler);
  return {
    guidance: await instructionHandler({}, context),
    skill: (await skillHandler({}, context)) as SkillDefinition | null,
    tool: await toolHandler({}, context),
  };
}

test("code({}) contributes no GitHub tool, instructions, or pr skill", async () => {
  extension({});
  const { guidance, skill, tool } = await resolve();
  assert.equal(tool, null);
  assert.equal(guidance, null);
  assert.equal(skill, null);
});

test("deprecated code({ github }) keeps the gh tool, GitHub instructions, and signed-commit pr skill", async () => {
  extension({ github: { connector: "github/acme-bot", org: "acme", broker: async () => {} } });
  const { guidance, skill, tool } = await resolve();
  assert.ok(tool && "execute" in tool);
  assert.ok(guidance && "content" in guidance);
  assert.match(
    guidance.content ?? "",
    /Use the `gh` tool for every authenticated GitHub operation/u,
  );
  assert.match(guidance.content ?? "", /Load the pr skill before publishing/u);
  assert.ok(skill);
  assert.match(skill.markdown, /gh-signed-commit/u);
  assert.match(skill.markdown, /gh pr create --draft/u);
});
