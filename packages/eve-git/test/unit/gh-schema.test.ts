import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { githubShellInputSchema } from "../../extension/lib/github-shell-schema.ts";

const input = {
  command: "gh pr view 1 --repo vercel/eve",
  description: "Read the pull request",
  repository: "vercel/eve",
};

test("gh input is a flat object with an optional repository", () => {
  const schema = z.toJSONSchema(githubShellInputSchema, { io: "input", target: "draft-7" });
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["command", "description"]);
  assert.equal("permissions" in (schema.properties ?? {}), false);
});

test("gh accepts an owner/name, an owner, or no repository", () => {
  assert.deepEqual(githubShellInputSchema.parse(input), input);
  assert.equal(githubShellInputSchema.safeParse({ ...input, repository: "vercel" }).success, true);
  const { repository: _repository, ...unscoped } = input;
  assert.equal(githubShellInputSchema.safeParse(unscoped).success, true);
  for (const repository of ["", "vercel/eve/extra", "-vercel", "vercel/"]) {
    assert.equal(
      githubShellInputSchema.safeParse({ ...input, repository }).success,
      false,
      repository,
    );
  }
});
