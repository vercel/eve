import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { userPreferencesKey } from "./user-preferences.js";

const put = mock.fn(async (pathname: string) => ({ pathname }));
const get = mock.fn(async () => ({
  stream: new Response("Send a weekly summary.").body,
}));
mock.module("@vercel/blob", { namedExports: { get, put } });

const { default: save } = await import("../tools/save_user_preferences.js");
const { default: load } = await import("../tools/get_user_preferences.js");
const principal = { principalId: "alice", principalType: "user" };
const context = { session: { auth: { current: principal } } } as Parameters<
  NonNullable<typeof save.execute>
>[1];

test("preferences use authenticated private Blob reads and writes", async () => {
  const key = userPreferencesKey(principal);
  const preferences = "Send a weekly summary.";
  assert.ok(save.execute);
  assert.ok(load.execute);
  await save.execute({ preferences }, context);
  assert.deepEqual(put.mock.calls[0]?.arguments, [
    key,
    preferences,
    {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "text/markdown",
    },
  ]);
  assert.deepEqual(await load.execute({}, context), {
    found: true,
    preferences,
  });
  assert.deepEqual(get.mock.calls[0]?.arguments, [key, { access: "private" }]);
});
