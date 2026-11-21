import assert from "node:assert/strict";
import { test } from "node:test";

import { addressBarUrl, controlMessage } from "./live-config.ts";

test("controlMessage reads the history buttons", () => {
  assert.deepEqual(controlMessage('{"type":"history","action":"back"}'), {
    type: "history",
    action: "back",
  });
  assert.deepEqual(controlMessage('{"type":"history","action":"rm -rf"}'), { type: "invalid" });
});

test("controlMessage opens only http(s) URLs from the address bar", () => {
  assert.deepEqual(controlMessage('{"type":"open","url":"example.com"}'), {
    type: "open",
    url: "https://example.com/",
  });
  assert.deepEqual(controlMessage('{"type":"open","url":"javascript:alert(1)"}'), {
    type: "invalid",
  });
  assert.deepEqual(controlMessage('{"type":"open","url":"file:///etc/passwd"}'), {
    type: "invalid",
  });
});

test("controlMessage leaves stream input and malformed JSON alone", () => {
  assert.equal(controlMessage('{"type":"input_mouse","eventType":"mouseMoved"}'), null);
  assert.equal(controlMessage('{"type":"open"'), null);
});

test("addressBarUrl refuses blank, spaced, and oversized input", () => {
  assert.equal(addressBarUrl("   "), null);
  assert.equal(addressBarUrl("two words"), null);
  assert.equal(addressBarUrl(`https://example.com/${"a".repeat(2048)}`), null);
});
