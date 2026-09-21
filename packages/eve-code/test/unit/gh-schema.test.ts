import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import gh from "../../extension/tools/gh.ts";

const permission = {
  provider: "github",
  repositories: ["vercel/eve"],
  access: "write",
};
const input = {
  command: "gh pr view 1 --repo vercel/eve",
  description: "Read the pull request",
  permissions: [permission],
};

test("gh permission schemas use homogeneous array items for provider compatibility", () => {
  assert.ok(gh.inputSchema instanceof z.ZodObject);
  const schema = z.toJSONSchema(gh.inputSchema, { target: "draft-7" });
  const permissions = schema.properties?.permissions;
  assert.ok(permissions && typeof permissions === "object");
  assert.equal(permissions.type, "array");
  assert.equal(permissions.minItems, 1);
  assert.equal(permissions.maxItems, 1);
  assert.ok(permissions.items && typeof permissions.items === "object");
  assert.equal(Array.isArray(permissions.items), false);
});

test("gh still requires exactly one permission and one repository", () => {
  assert.ok(gh.inputSchema instanceof z.ZodObject);
  assert.deepEqual(gh.inputSchema.parse(input), input);
  for (const permissions of [
    [],
    [permission, permission],
    [{ ...permission, repositories: [] }],
    [{ ...permission, repositories: ["vercel/eve", "vercel/other"] }],
    [{ ...permission, repositories: ["not-a-repository"] }],
    [{ ...permission, provider: "other" }],
    [{ ...permission, access: "read" }],
  ]) {
    assert.equal(gh.inputSchema.safeParse({ ...input, permissions }).success, false);
  }
});
