import { describe, expect, it, vi } from "vitest";

import {
  createVercelToolSessionSweeper,
  VERCEL_TOOL_SESSION_NAME_PREFIX,
} from "#execution/sandbox/bindings/vercel-tool-sessions.js";
import { TOOL_SESSION_ID_PREFIX } from "#execution/tool-session/id.js";

vi.mock("#compiled/@vercel/oidc/index.js", () => ({
  getVercelOidcToken: vi.fn(async () => {
    throw new Error("No ambient Vercel OIDC token in unit tests.");
  }),
}));

const CREATE_OPTIONS = { projectId: "prj", teamId: "team", token: "tok" } as never;

function record(name: string, tags: Record<string, string> | undefined, status = "stopped") {
  return {
    delete: vi.fn(async () => {}),
    name,
    status,
    statusUpdatedAt: new Date(1000),
    tags,
    updatedAt: new Date(2000),
  };
}

function sweeperOver(records: ReturnType<typeof record>[]) {
  const sandboxModule = {
    Sandbox: {
      get: vi.fn(async ({ name }: { name: string }) => {
        const found = records.find((candidate) => candidate.name === name);
        if (found === undefined) throw Object.assign(new Error("not found"), { status: 404 });
        return found;
      }),
      list: vi.fn(async function* () {
        yield* records.map((candidate) => ({
          ...candidate,
          statusUpdatedAt: 1000,
          updatedAt: 2000,
        }));
      }),
    },
  };
  const sweeper = createVercelToolSessionSweeper({
    createOptions: CREATE_OPTIONS,
    loadSandboxModule: async () => sandboxModule as never,
  });
  return { sandboxModule, sweeper };
}

describe("createVercelToolSessionSweeper", () => {
  const owned = record(`${VERCEL_TOOL_SESSION_NAME_PREFIX}owned`, {
    sessionId: `${TOOL_SESSION_ID_PREFIX}abc`,
  });
  const untagged = record(`${VERCEL_TOOL_SESSION_NAME_PREFIX}untagged`, undefined);
  const foreign = record(`${VERCEL_TOOL_SESSION_NAME_PREFIX}foreign`, {
    sessionId: "sess_from_a_conversation",
  });

  it("lists only sandboxes tagged with a tool session id", async () => {
    const { sandboxModule, sweeper } = sweeperOver([owned, untagged, foreign]);
    expect(await sweeper.list()).toEqual([
      {
        lastUsedAt: 2000,
        name: owned.name,
        running: false,
        sessionId: `${TOOL_SESSION_ID_PREFIX}abc`,
      },
    ]);
    expect(sandboxModule.Sandbox.list).toHaveBeenCalledWith(
      expect.objectContaining({ namePrefix: VERCEL_TOOL_SESSION_NAME_PREFIX }),
    );
  });

  it("deletes a tool-session sandbox after a fresh read unless kept", async () => {
    const { sweeper } = sweeperOver([owned]);
    expect(await sweeper.deleteUnless(owned.name, () => true)).toBe(false);
    expect(owned.delete).not.toHaveBeenCalled();
    expect(await sweeper.deleteUnless(owned.name, (current) => current.running)).toBe(true);
    expect(owned.delete).toHaveBeenCalledWith({ deleteOrphanSnapshots: true });
  });

  it("never deletes a sandbox whose tag does not name a tool session", async () => {
    const { sweeper } = sweeperOver([untagged, foreign]);
    expect(await sweeper.deleteUnless(untagged.name, () => false)).toBe(false);
    expect(await sweeper.deleteUnless(foreign.name, () => false)).toBe(false);
    expect(await sweeper.deleteUnless("eve-ts-vercel-gone", () => false)).toBe(false);
    expect(untagged.delete).not.toHaveBeenCalled();
    expect(foreign.delete).not.toHaveBeenCalled();
  });
});
