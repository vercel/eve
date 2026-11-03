import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ParentSessionKey, SessionIdKey, type SessionParent } from "#context/keys.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { sessionFrameOf } from "./frame.js";
import { bindingOf } from "./remote.js";

function session(id: string, parent?: SessionParent): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, id);
  if (parent !== undefined) ctx.set(ParentSessionKey, parent);
  enterSessionProjection(ctx, undefined);
  return ctx;
}

const firstLevel: SessionParent = {
  callId: "call-root",
  rootSessionId: "root",
  sessionId: "root",
  turn: { id: "turn-root", sequence: 0 },
};

const deeper: SessionParent = {
  callId: "call-child",
  rootSessionId: "root",
  sessionId: "child",
  turn: { id: "turn-child", sequence: 2 },
};

describe("sessionFrameOf", () => {
  it("gives a root session no parent, rather than one inferred from its own ID", () => {
    expect(sessionFrameOf(session("root")).session).not.toHaveProperty("parent");
  });

  it.each([
    ["a first-level child", "child", firstLevel],
    ["a deeper child, whose immediate parent isn't the root", "grandchild", deeper],
  ])("gives %s its parent's lineage as delegation recorded it", (_name, id, parent) => {
    expect(sessionFrameOf(session(id, parent)).session.parent).toEqual(parent);
  });

  it("keeps the parent in a remote child's binding, which credentials are rebuilt from", () => {
    expect(bindingOf(session("grandchild", deeper), "subagents/finance").session.parent).toEqual(
      deeper,
    );
    expect(bindingOf(session("root"), "subagents/finance").session).not.toHaveProperty("parent");
  });
});
