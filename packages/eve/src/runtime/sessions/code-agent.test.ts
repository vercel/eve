import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ParentSessionKey } from "#context/keys.js";
import type { Definition } from "#definitions/definition.js";
import { subagentDefinitionOf } from "#definitions/delegation.js";
import { codeAgentRevision, createSessionAgent } from "#runtime/sessions/code-agent.js";
import {
  holdSessionAgent,
  resolveHeldSessionAgent,
  runtimeNodeId,
} from "#runtime/sessions/session-agent.js";

const definition = (id: string): Definition => ({ contribute: () => ({}), id, label: id });

/** A session another session's call started. */
function childSession(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(ParentSessionKey, {
    callId: "call-1",
    rootSessionId: "session_root",
    sessionId: "session_root",
    turn: { id: "turn-1", sequence: 1 },
  });
  return ctx;
}

describe("createSessionAgent", () => {
  it("is carried by its id, at the root, with no sandbox, and delegates only to its copy", async () => {
    const agent = createSessionAgent({ definitions: [definition("tool:deploy")], id: "release" });
    expect(agent.reference).toEqual({ id: "release", kind: "runtime" });
    expect(agent.compiled).toBeUndefined();
    expect(runtimeNodeId(agent)).toBe("__root__");
    expect(agent.settings).toEqual({});
    // Only a root session's `agent` tool starts a copy; a child session has a parent.
    expect(agent.delegates(new ContextContainer())).toEqual({ agent: { description: "" } });
    expect(agent.delegates(childSession())).toEqual({});
    await expect(agent.sandbox()).resolves.toBeUndefined();
    expect((await agent.definitions()).map(({ id }) => id)).toEqual(["tool:deploy"]);
  });
});

describe("codeAgentRevision", () => {
  it("names the agent's id and definition ids, in any order, and the host's version", () => {
    const ids = [definition("tool:a"), definition("tool:b")];
    const revision = codeAgentRevision("release", ids);
    expect(revision).toMatch(/^agent:[\w-]{22}$/);
    expect(codeAgentRevision("release", [...ids].reverse())).toBe(revision);
    expect(codeAgentRevision("release", [definition("tool:a")])).not.toBe(revision);
    expect(codeAgentRevision("other", ids)).not.toBe(revision);
    expect(codeAgentRevision("release", ids, "2")).not.toBe(revision);
  });

  it("keeps the digest #2 wrote with node:crypto", () => {
    const ids = [definition("tool:a"), definition("tool:b")];
    expect(codeAgentRevision("release", ids)).toBe("agent:Utb8AuSFACg2vArKCFyRSu");
    expect(codeAgentRevision("release", ids, "2")).toBe("agent:MSvqMXAT7Fo3oeBkQrW04L");
  });
});

describe("subagents", () => {
  const reviewer = () =>
    createSessionAgent({
      definitions: [],
      description: "Reviews a change.",
      id: "reviewer",
    });

  it("scopes each subagent's id by its parent's, at its own node", () => {
    const parent = createSessionAgent({
      definitions: [subagentDefinitionOf("reviewer", reviewer())],
      id: "release",
    });
    const child = parent.subagents.get("reviewer")?.agent;
    expect(child?.id).toBe("release/reviewer");
    expect(child?.nodeId).toBe("subagents/reviewer");
    expect(parent.delegates(new ContextContainer())).toEqual({
      agent: { description: "" },
      reviewer: { description: "Reviews a change." },
    });
  });

  it("resolves a subagent and the root's copy through its roster", () => {
    const parent = createSessionAgent({
      definitions: [subagentDefinitionOf("reviewer", reviewer())],
      id: "release",
    });
    const roster = parent.roster({});
    const call = roster.resolveAction("call-1", { message: "Check it.", target: "reviewer" });
    expect(call).toMatchObject({ kind: "subagent-call", nodeId: "subagents/reviewer" });
    const local = roster.startTarget(call, true);
    expect(local.kind === "local" && roster.childRuntime(local, undefined)).toEqual({
      agent: parent.subagents.get("reviewer")?.agent,
    });
    const copy = roster.resolveAction("call-2", { message: "Try again.", target: "agent" });
    const copied = roster.startTarget(copy, true);
    expect(copied.kind === "local" && roster.childRuntime(copied, undefined)).toEqual({
      agent: parent,
    });
    expect(() => roster.startTarget(copy, false)).toThrow(
      'The built-in "agent" tool is only available to the root session.',
    );
    expect(() => roster.resolveAction("call-3", { message: "Hi.", target: "nobody" })).toThrow(
      'Agent target "nobody" is not available to this agent.',
    );
  });

  it("needs a description, which the parent's model reads", () => {
    expect(() =>
      subagentDefinitionOf("helper", createSessionAgent({ definitions: [], id: "helper" })),
    ).toThrow('Subagent "helper" needs a description');
  });

  it("is held with its parent, and released with it", () => {
    const parent = createSessionAgent({
      definitions: [subagentDefinitionOf("reviewer", reviewer())],
      id: "held-parent",
    });
    const release = holdSessionAgent(parent);
    expect(resolveHeldSessionAgent("held-parent/reviewer")).toBe(
      parent.subagents.get("reviewer")?.agent,
    );
    release();
    expect(() => resolveHeldSessionAgent("held-parent/reviewer")).toThrow();
  });
});

describe("holdSessionAgent", () => {
  it("resolves an agent by id until every hold of it is released", () => {
    const agent = createSessionAgent({ definitions: [], id: "held-twice" });
    const first = holdSessionAgent(agent);
    const second = holdSessionAgent(agent);
    first();
    first();
    expect(resolveHeldSessionAgent("held-twice")).toBe(agent);
    second();
    expect(() => resolveHeldSessionAgent("held-twice")).toThrow(
      'No agent "held-twice" is held in this process.',
    );
  });

  it("replaces an agent held under the same id with a newer one", () => {
    const older = createSessionAgent({ definitions: [], id: "rebuilt" });
    const newer = createSessionAgent({ definitions: [], id: "rebuilt" });
    const releaseOlder = holdSessionAgent(older);
    const releaseNewer = holdSessionAgent(newer);
    expect(resolveHeldSessionAgent("rebuilt")).toBe(newer);
    // The older hold's release leaves the newer agent held.
    releaseOlder();
    expect(resolveHeldSessionAgent("rebuilt")).toBe(newer);
    releaseNewer();
    expect(() => resolveHeldSessionAgent("rebuilt")).toThrow();
  });
});
