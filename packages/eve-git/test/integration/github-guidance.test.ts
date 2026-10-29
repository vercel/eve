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
  channel: { kind: "http" as const, metadata: {} },
};

// A defineDynamic() value is opaque; eve keeps its function under this cross-instance brand.
async function run<T>(definition: unknown): Promise<T> {
  const evaluate = (definition as Record<symbol, (ctx: never) => unknown>)[
    Symbol.for("eve.dynamic")
  ]!;
  return (await evaluate(context as never)) as T;
}

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
  assert.doesNotMatch(skill.content, /gh-signed-commit|gh`? tool/u);
  assert.doesNotMatch(skill.description, /signed commit/u);
  assert.match(skill.content, /commit them, and push the branch/u);
  assert.match(skill.content, /gh pr create --draft/u);
});

test("with github config, GitHub goes through the brokered gh tool and signed commits", async () => {
  extension({
    github: {
      connector: "github/acme-bot",
      authorize: () => true,
      broker: async () => {},
      principalType: "app",
    },
  });
  const { content, skill, tool } = await resolve();
  assert.ok(tool && "execute" in tool);
  assert.match(content, /GitHub credentials are not available to ordinary `bash`/u);
  assert.match(content, /Use the `gh` tool for every authenticated GitHub operation/u);
  assert.match(content, /Load the pr skill before publishing/u);
  // The agent discovers repositories itself instead of asking for an exact owner/name.
  assert.match(content, /gh search repos/u);
  assert.match(content, /gh repo list <owner>/u);
  assert.match(content, /Do not ask the requester for an exact `owner\/name`/u);
  assert.match(skill.content, /gh-signed-commit/u);
  assert.match(skill.description, /signed commit/u);
  assert.match(skill.content, /gh pr create --draft/u);
});

test("github config without authorize is rejected, so brokered access never defaults to allow", () => {
  assert.throws(
    () =>
      extension({
        github: { connector: "github/acme-bot", broker: async () => {}, principalType: "app" },
      } as never),
    /github\.authorize/u,
  );
  // principalType selects what authorize receives, so it is required.
  assert.throws(
    () =>
      extension({
        github: { connector: "github/acme-bot", broker: async () => {}, authorize: () => true },
      } as never),
    /github\.principalType/u,
  );
});

test("with a user principal, guidance describes the caller's token instead of repository scope", async () => {
  extension({
    github: {
      connector: "github/acme-bot",
      authorize: () => true,
      broker: async () => {},
      principalType: "user",
    },
  });
  const { content, tool } = await resolve();
  assert.ok(tool && "description" in tool && typeof tool.description === "string");
  for (const text of [content, tool.description]) {
    assert.match(text, /caller's own GitHub token/u);
    assert.match(text, /caller's GitHub permissions/u);
    assert.match(text, /gh api user\/repos/u);
    assert.doesNotMatch(
      text,
      /server-side repository scope|remains scoped to the declared repository|exactly one/u,
    );
  }
});
