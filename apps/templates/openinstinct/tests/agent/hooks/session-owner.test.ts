import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryConsumed } from "eve/events";
import type { HookContext } from "eve/hooks";
import type { saveChat } from "@db/services/chats";
import type { ensureScope } from "@db/services/scope";
import type { claimSession } from "@db/services/sessions";
import sessionOwner from "@agent/hooks/session-owner";
import { hookContextFor } from "@tests/helpers/hook-context";

const mocks = vi.hoisted(() => ({
  claimSession: vi.fn<typeof claimSession>(),
  ensureScope: vi.fn<typeof ensureScope>(),
  saveChat: vi.fn<typeof saveChat>(),
}));

vi.mock("@db/services/chats", () => ({ saveChat: mocks.saveChat }));
vi.mock("@db/services/scope", () => ({ ensureScope: mocks.ensureScope }));
vi.mock("@db/services/sessions", () => ({
  claimSession: mocks.claimSession,
}));

const scope = { userId: "user-1", workspaceId: "workspace-1" };
const auth: HookContext["session"]["auth"] = {
  current: null,
  initiator: {
    attributes: { workspaceId: scope.workspaceId },
    authenticator: "test",
    principalId: scope.userId,
    principalType: "user",
  },
};
const consumed: DeliveryConsumed = {
  data: {
    deliveryId: "delivery-1",
    parts: [{ kind: "text", text: "hello" }],
    turnId: "turn-1",
  },
  scope: { turnId: "turn-1" },
  type: "delivery.consumed",
};

function contextFor(kind: HookContext["channel"]["kind"]) {
  return hookContextFor({
    auth,
    channel: { kind, metadata: {} },
    sessionId: "session-1",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claimSession.mockResolvedValue();
  mocks.ensureScope.mockResolvedValue();
  mocks.saveChat.mockResolvedValue();
});

describe("session ownership hook", () => {
  it("repairs ownership before indexing a received message", async () => {
    const handler = sessionOwner.events["delivery.consumed"];
    expect(handler).toBeDefined();

    await handler?.(consumed, contextFor("channel:linq"));

    expect(mocks.ensureScope).toHaveBeenCalledWith(scope);
    expect(mocks.claimSession).toHaveBeenCalledWith(scope, "session-1");
    expect(mocks.saveChat).toHaveBeenCalledWith(scope, {
      channel: "channel:linq",
      sessionId: "session-1",
    });
    expect(mocks.ensureScope.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.claimSession.mock.invocationCallOrder[0] ?? 0
    );
    expect(mocks.claimSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.saveChat.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("records the web channel for HTTP messages", async () => {
    const handler = sessionOwner.events["delivery.consumed"];
    await handler?.(consumed, contextFor("channel:eve"));

    expect(mocks.saveChat).toHaveBeenCalledWith(scope, {
      channel: "channel:eve",
      sessionId: "session-1",
    });
  });
});
