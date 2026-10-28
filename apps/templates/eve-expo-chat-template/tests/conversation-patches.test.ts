import { test } from "node:test";
import assert from "node:assert/strict";
import {
  conversationPatch,
  applyConversationPatch,
} from "../packages/protocol/src/conversation.ts";
test("stream patches preserve history references and replace a draft with its final message", () => {
  const history = { id: "user", text: "hello", createdAt: 1 },
    draft = { id: "reply", text: "Hel", createdAt: 2, status: "streaming" };
  const before = { asOf: 1, messages: [history], streams: [draft] },
    middle = { asOf: 2, messages: [history], streams: [{ ...draft, text: "Hello" }] };
  const delta = conversationPatch(before, middle);
  assert.deepEqual(delta.messages, []);
  assert.equal(delta.streams.length, 1);
  const updated = applyConversationPatch(before, delta);
  assert.equal(updated.messages[0], history);
  assert.deepEqual(updated, middle);
  const done = {
    asOf: 3,
    messages: [history, { id: "reply", text: "Hello!", createdAt: 2 }],
    streams: [],
  };
  assert.deepEqual(applyConversationPatch(updated, conversationPatch(updated, done)), done);
  assert.deepEqual(conversationPatch(updated, done).removedStreams, ["reply"]);
});

test("stream patches carry model and active response changes, including clearing after stop", () => {
  const before = { asOf: 1, messages: [], streams: [], model: null, activeResponse: null };
  const active = { ...before, asOf: 2, model: "provider/model", activeResponse: "request-id" };
  assert.deepEqual(applyConversationPatch(before, conversationPatch(before, active)), active);
  const stopped = { ...active, asOf: 3, activeResponse: null };
  assert.deepEqual(applyConversationPatch(active, conversationPatch(active, stopped)), stopped);
});
