import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CloudChrome } from "../packages/start/desktop/runtime/chrome.mjs";
test("cloud Chrome restarts after the last window exits and intentional shutdown never respawns it", async () => {
  const children: any[] = [];
  let alive = false,
    attached = 0,
    detached = 0,
    ready = false;
  const chrome = new CloudChrome({
    launch: () => {
      alive = true;
      const child = new EventEmitter() as any;
      child.kill = () => {
        alive = false;
        queueMicrotask(() => child.emit("exit", 0));
      };
      children.push(child);
      return child;
    },
    health: async () => {
      if (!alive) throw Error("Chrome closed");
    },
    attach: async () => {
      attached++;
    },
    detach: async () => {
      detached++;
    },
    onReady: (value: boolean) => {
      ready = value;
    },
    retryMs: 5,
    monitorMs: 10,
  });
  try {
    await chrome.start();
    assert.equal(ready, true);
    assert.equal(children.length, 1);
    alive = false;
    children[0].emit("exit", 0);
    assert.equal(ready, false);
    for (let i = 0; i < 50 && children.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    await chrome.ensure();
    assert.equal(children.length, 2);
    assert.equal(attached, 2);
    assert.equal(detached, 2);
    assert.equal(ready, true);
    await chrome.stop();
    assert.equal(ready, false);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(children.length, 2);
  } finally {
    await chrome.stop();
  }
});
