import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { startRegistryServer } from "../evals/self-modification/registry-server.ts";

test("serves only checkout-owned registry items and restores the override", async () => {
  const previous = process.env.EVE_DEV_OFFICIAL_REGISTRY_URL;
  const stop = await startRegistryServer();
  try {
    const base = process.env.EVE_DEV_OFFICIAL_REGISTRY_URL;
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/r$/);
    const catalog = await (await fetch(`${base}/registry.json`)).json();
    assert.deepEqual(
      catalog.items.map((item) => item.name),
      ["extension/agent-browser", "channel/slack"],
    );
    for (const item of catalog.items) {
      const response = await fetch(`${base}/${item.name}.json`);
      assert.equal(response.status, 200);
      const manifest = await response.json();
      assert.equal(manifest.name, item.name);
      for (const file of manifest.files ?? []) {
        assert.equal(
          file.content,
          await readFile(resolve("../../../apps/docs", file.path), "utf8"),
        );
      }
    }
    assert.equal((await fetch(`${base}/channel/telegram.json`)).status, 404);
  } finally {
    await stop();
  }
  assert.equal(process.env.EVE_DEV_OFFICIAL_REGISTRY_URL, previous);
});
