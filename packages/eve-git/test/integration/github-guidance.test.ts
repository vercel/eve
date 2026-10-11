import assert from "node:assert/strict";
import test from "node:test";
import type { SkillDefinition } from "eve/skills";

import extension from "../../extension/extension.ts";
import instructions from "../../extension/instructions/github.ts";
import pr from "../../extension/skills/pr.ts";
import gh from "../../extension/tools/gh.ts";

const context = {
  model: null,
  session: { id: "guidance-test", auth: { current: null, initiator: null } },
  channel: {},
  messages: [],
};

async function resolve() {
  const instructionHandler = instructions.events["session.started"];
  const skillHandler = pr.events["session.started"];
  const toolHandler = gh.events["session.started"];
  assert.ok(instructionHandler && skillHandler && toolHandler);
  const guidance = await instructionHandler({}, context);
  assert.ok(guidance && "content" in guidance);
  return {
    content: guidance.content ?? "",
    skill: (await skillHandler({}, context)) as SkillDefinition,
    tool: await toolHandler({}, context),
  };
}

test("without github config, GitHub goes through the shell's gh and git", async () => {
  extension({});
  const { content, skill, tool } = await resolve();
  assert.equal(tool, null);
  assert.match(content, /Use the `gh` and `git` CLIs in `bash`/u);
  assert.doesNotMatch(content, /not available to ordinary `bash`|`gh` tool/u);
  assert.match(content, /Load the pr skill before publishing/u);
  assert.doesNotMatch(skill.markdown, /gh-signed-commit|gh`? tool/u);
  assert.doesNotMatch(skill.description, /signed commit/u);
  assert.match(skill.markdown, /commit them, and push the branch/u);
  assert.match(skill.markdown, /gh pr create --draft/u);
});

test("with github config, GitHub goes through the brokered gh tool and signed commits", async () => {
  extension({ github: { connector: "github/acme-bot", org: "acme", broker: async () => {} } });
  const { content, skill, tool } = await resolve();
  assert.ok(tool && "execute" in tool);
  assert.match(content, /GitHub credentials are not available to ordinary `bash`/u);
  assert.match(content, /Use the `gh` tool for every authenticated GitHub operation/u);
  assert.match(content, /Load the pr skill before publishing/u);
  assert.match(skill.markdown, /gh-signed-commit/u);
  assert.match(skill.description, /signed commit/u);
  assert.match(skill.markdown, /gh pr create --draft/u);
});
