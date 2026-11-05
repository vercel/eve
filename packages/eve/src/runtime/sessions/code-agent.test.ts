import { describe, expect, it } from "vitest";

import type { Definition } from "#definitions/definition.js";
import { codeAgentRevision, createSessionAgent } from "#runtime/sessions/code-agent.js";
import {
  holdSessionAgent,
  resolveHeldSessionAgent,
  runtimeNodeId,
} from "#runtime/sessions/session-agent.js";

const definition = (id: string): Definition => ({ contribute: () => ({}), id, label: id });

describe("createSessionAgent", () => {
  it("is carried by its id, at the root, with no sandbox and no delegates", async () => {
    const agent = createSessionAgent({ definitions: [definition("tool:deploy")], id: "release" });
    expect(agent.reference).toEqual({ id: "release", kind: "runtime" });
    expect(agent.compiled).toBeUndefined();
    expect(runtimeNodeId(agent)).toBe("__root__");
    expect(agent.settings).toEqual({});
    expect(agent.delegates({} as never)).toEqual({});
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

  it("keeps the digest node:crypto's SHA-256 gave", () => {
    const ids = [definition("tool:a"), definition("tool:b")];
    expect(codeAgentRevision("release", ids)).toBe("agent:Utb8AuSFACg2vArKCFyRSu");
    expect(codeAgentRevision("release", ids, "2")).toBe("agent:MSvqMXAT7Fo3oeBkQrW04L");
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
