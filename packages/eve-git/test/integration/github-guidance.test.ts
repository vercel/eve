import assert from "node:assert/strict";
import test from "node:test";
import type { SkillDefinition } from "eve/skills";

import extension from "../../extension/extension.ts";
import instructions from "../../extension/instructions/github.ts";
import pr from "../../extension/skills/pr.ts";
import gh from "../../extension/tools/gh.ts";

const context = {
  abortSignal: new AbortController().signal,
  session: { id: "guidance-test", auth: { current: null, initiator: null } },
  channel: {},
};

/** Runs a definition as the runner does: `select`, then `record` if any, then `render` if any. */
async function run<T>(definition: {
  select: (view: never, ctx: never) => unknown;
  record?: (selected: never, ctx: never) => unknown;
  render?: (input: never) => unknown;
}): Promise<T> {
  const selected = definition.select({} as never, context as never);
  const recorded =
    definition.record === undefined
      ? selected
      : await definition.record(selected as never, context as never);
  return (definition.render === undefined ? recorded : definition.render(recorded as never)) as T;
}

/** Resolves each definition once, as the runner does for `select: once`. */
async function resolve() {
  const guidance = await run<{ content?: string } | null>(instructions);
  assert.ok(guidance && "content" in guidance);
  return {
    content: guidance.content ?? "",
    skill: await run<SkillDefinition>(pr),
    tool: await run<object | null>(gh),
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
