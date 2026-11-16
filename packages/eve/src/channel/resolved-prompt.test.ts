import { expect, it } from "vitest";

import type { RequestSettlement } from "#channel/interaction-prompts.js";
import { resolvedPromptLabel, responderName } from "#channel/resolved-prompt.js";

const options = [{ id: "sat", label: "Saturday" }];
const approved: RequestSettlement = {
  interactionId: "i_1",
  kind: "approval",
  outcome: "accepted",
  responder: { id: "p_alice", type: "user" },
};
const answered: RequestSettlement = {
  answer: { interactionId: "i_2", optionId: "sat" },
  interactionId: "i_2",
  kind: "question",
  outcome: "accepted",
  responder: { id: "p_alice", type: "user" },
};

it("names who gave the deciding answer", () => {
  expect(resolvedPromptLabel(approved, [], "Alice")).toBe("Approved by Alice");
  expect(resolvedPromptLabel({ ...approved, outcome: "declined" }, [], "Alice")).toBe(
    "Cancelled by Alice",
  );
  expect(resolvedPromptLabel(answered, options, "Alice")).toBe("Answered by Alice: Saturday");
});

it("names nobody when the responder is unknown or nobody answered", () => {
  expect(resolvedPromptLabel(approved)).toBe("Approved");
  expect(resolvedPromptLabel(answered, options)).toBe("Answered: Saturday");
  expect(resolvedPromptLabel({ ...answered, outcome: "withdrawn" }, options, "Alice")).toBe(
    "No longer needed",
  );
});

it("looks the responder up by principal id", () => {
  expect(responderName({ p_alice: "Alice" }, approved)).toBe("Alice");
  expect(responderName({ p_bob: "Bob" }, approved)).toBeUndefined();
  expect(
    responderName({ p_alice: "Alice" }, { ...approved, responder: undefined }),
  ).toBeUndefined();
});
