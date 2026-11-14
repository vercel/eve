import {
  defineMemoryProvider,
  type MemoryScopeContext,
  type MemoryTurnStartedContext,
  type MemoryToolsContext,
} from "eve/memory";
import { describe, expect, it } from "vitest";
import personalInfoMemory from "@agent/memory/personal_info";
import {
  preserveProfileMemoryCancellation,
  resolveProfileMemoryBackend,
  resolveProfileMemoryScope,
} from "@agent/lib/profile-memory";
import { accessScopeForUser } from "@shared/identity/access-scope";

const derivedWorkspaceId = accessScopeForUser("better-auth:user").workspaceId;

describe("profile memory", () => {
  it("uses an explicit Blob backend for an attached store in production", () => {
    expect(
      resolveProfileMemoryBackend({
        BLOB_READ_WRITE_TOKEN: undefined,
        BLOB_STORE_ID: "store-id",
        NODE_ENV: "production",
        VERCEL_ENV: "production",
      })
    ).toEqual({
      kind: "vercel-blob",
      options: { storeId: "store-id" },
    });
    expect(
      resolveProfileMemoryBackend({
        BLOB_READ_WRITE_TOKEN: "blob-token",
        BLOB_STORE_ID: undefined,
        NODE_ENV: "production",
        VERCEL_ENV: undefined,
      })
    ).toEqual({
      kind: "vercel-blob",
      options: { token: "blob-token" },
    });
    expect(
      resolveProfileMemoryBackend({
        BLOB_READ_WRITE_TOKEN: "blob-token",
        BLOB_STORE_ID: undefined,
        NODE_ENV: "production",
        VERCEL_ENV: "production",
      })
    ).toEqual({ kind: "automatic" });
    expect(
      resolveProfileMemoryBackend({
        BLOB_READ_WRITE_TOKEN: "blob-token",
        BLOB_STORE_ID: "store-id",
        NODE_ENV: "development",
        VERCEL_ENV: undefined,
      })
    ).toEqual({ kind: "automatic" });
  });

  it("shares the canonical workspace across verified authenticators", () => {
    const workspaceId = derivedWorkspaceId;
    expect(
      resolveProfileMemoryScope(
        memoryContext(userPrincipal("authjs", workspaceId))
      )
    ).toBe(workspaceId);
    expect(
      resolveProfileMemoryScope(
        memoryContext(userPrincipal("linq-message", workspaceId))
      )
    ).toBe(workspaceId);
  });

  it("disables memory without an authenticated workspace user", () => {
    expect(resolveProfileMemoryScope(memoryContext(null))).toBeNull();
    expect(
      resolveProfileMemoryScope(
        memoryContext({
          ...userPrincipal("runtime", derivedWorkspaceId),
          principalType: "runtime",
        })
      )
    ).toBeNull();
    expect(
      resolveProfileMemoryScope(memoryContext(userPrincipal("authjs")))
    ).toBeNull();
  });

  it("shares personal information with a worker acting for the user", () => {
    expect(
      personalInfoMemory.scope(
        memoryContext(
          {
            attributes: {},
            authenticator: "runtime",
            principalId: "worker",
            principalType: "runtime",
          },
          userPrincipal("authjs", derivedWorkspaceId)
        )
      )
    ).toBe(derivedWorkspaceId);
  });

  it("omits user memory from scheduled reporting turns", () => {
    const context = memoryContext(
      userPrincipal("scheduled-result", derivedWorkspaceId)
    );

    expect(resolveProfileMemoryScope(context)).toBeNull();
    expect(personalInfoMemory.scope(context)).toBeNull();
  });

  it("offers profile updates only during interactive turns", async () => {
    const interactiveTools = await personalInfoMemory.provider.tools(
      memoryToolsContext(userPrincipal("authjs", derivedWorkspaceId))
    );
    expect(Object.keys(interactiveTools ?? {})).toEqual(["update"]);

    const scheduledTools = await personalInfoMemory.provider.tools(
      memoryToolsContext(userPrincipal("scheduled-worker", derivedWorkspaceId))
    );
    expect(scheduledTools).toBeNull();
  });

  it("preserves the turn cancellation reason when recall loses it", async () => {
    const blobAbort = new DOMException(
      "This operation was aborted",
      "AbortError"
    );
    const cancellation = Object.assign(new Error("The turn was cancelled."), {
      name: "TurnCancelledError",
    });
    const controller = new AbortController();
    controller.abort(cancellation);
    const provider = preserveProfileMemoryCancellation(
      defineMemoryProvider({
        recall: {
          async "turn.started"() {
            throw blobAbort;
          },
        },
      })
    );

    await expect(
      provider.recall["turn.started"](memoryOperationContext(controller.signal))
    ).rejects.toBe(cancellation);
  });

  it("does not hide a recall failure while the turn remains active", async () => {
    const blobAbort = new DOMException(
      "This operation was aborted",
      "AbortError"
    );
    const provider = preserveProfileMemoryCancellation(
      defineMemoryProvider({
        recall: {
          async "turn.started"() {
            throw blobAbort;
          },
        },
      })
    );

    await expect(
      provider.recall["turn.started"](
        memoryOperationContext(new AbortController().signal)
      )
    ).rejects.toBe(blobAbort);
  });
});

function memoryOperationContext(
  abortSignal: AbortSignal
): MemoryTurnStartedContext {
  return {
    abortSignal,
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    memory: {
      scope: {
        key: "personal-info-key",
        namespace: "openinstinct-profile-memory-v1",
        value: "personal:workspace",
      },
      slot: "profile",
    },
    messages: [],
    operationId: "memory-operation",
    session: {
      auth: {
        current: userPrincipal("authjs", "personal:workspace"),
        initiator: null,
      },
      id: "session",
      turn: { id: "turn", sequence: 1 },
    },
    turn: { id: "turn", input: [], sequence: 1 },
  };
}

function memoryToolsContext(
  current: MemoryToolsContext["session"]["auth"]["current"],
  initiator: MemoryToolsContext["session"]["auth"]["initiator"] = null
): MemoryToolsContext {
  return {
    abortSignal: new AbortController().signal,
    channel: { kind: "channel:eve", metadata: {} },
    memory: {
      scope: {
        key: "personal-info-key",
        namespace: "openinstinct-personal-info-v1",
        value: derivedWorkspaceId,
      },
      slot: "personal_info",
    },
    session: {
      auth: { current, initiator },
      id: "session",
    },
  };
}

function memoryContext(
  current: MemoryScopeContext["session"]["auth"]["current"],
  initiator: MemoryScopeContext["session"]["auth"]["initiator"] = null
): MemoryScopeContext {
  return {
    abortSignal: new AbortController().signal,
    channel: { kind: "channel:eve", metadata: {} },
    session: {
      auth: { current, initiator },
      id: "session",
    },
  };
}

function userPrincipal(
  authenticator: string,
  workspaceId?: string
): NonNullable<MemoryScopeContext["session"]["auth"]["current"]> {
  return {
    attributes: workspaceId === undefined ? {} : { workspaceId },
    authenticator,
    principalId: "better-auth:user",
    principalType: "user",
  };
}
