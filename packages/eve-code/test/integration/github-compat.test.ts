import assert from "node:assert/strict";
import test from "node:test";
import type { SkillDefinition } from "eve/skills";

import extension from "../../extension/extension.ts";
import instructions from "../../extension/instructions/github.ts";
import pr from "../../extension/skills/pr.ts";
import gh from "../../extension/tools/gh.ts";

const context = {
  abortSignal: new AbortController().signal,
  session: { id: "github-compat-test", auth: { current: null, initiator: null } },
  channel: {},
};

/** Resolves each definition once, as the runner does for a `select` of null. */
async function resolve() {
  return {
    guidance: await instructions.resolve(instructions.select({} as never, context), context),
    skill: (await pr.resolve(pr.select({} as never, context), context)) as SkillDefinition | null,
    tool: await gh.resolve(gh.select({} as never, context), context),
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
